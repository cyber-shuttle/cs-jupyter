import { Dialog, showDialog } from "@jupyterlab/apputils";
import { Signal } from "@lumino/signaling";
import { Panel, StackedPanel, Widget } from "@lumino/widgets";
import { AuthInteractionRequiredError } from "./AuthClient";
import { CreateRuntimeForm } from "./CreateRuntimeForm";
import {
  IRuntime,
  IRuntimeCreateRequest,
  ISshHost,
  isTerminal,
} from "./Common";
import { ControlClient, errorMessage, IRuntimeLogTail } from "./ControlClient";
import { RuntimeController } from "./RuntimeController";
import { RuntimeDetail } from "./RuntimeDetail";
import {
  cacheRuntimeAccess,
  clearRuntimeAccess,
  loadRuntimeAccess,
} from "./runtime-access";
import { CyberShuttleHeader, RuntimeList } from "./RuntimeList";
import { SshHosts } from "./SshHosts";

/** How often the workspace re-reads cs-control. It caps its own SSH work at
 * the same rate, so polling faster would only add HTTP round trips. */
const RUNTIME_POLL_INTERVAL_MS = 1000;

export interface IRuntimeUiState {
  readonly runtimes: readonly IRuntime[];
  readonly logs: ReadonlyMap<string, IRuntimeLogTail>;
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly busyRuntimeIds: ReadonlySet<string>;
  readonly startingRuntimeIds: ReadonlySet<string>;
  readonly connectingRuntimeId: string | undefined;
  readonly jupyterReady: ReadonlySet<string>;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly authRequired: boolean;
  readonly account: string | undefined;
}

interface IJupyterOperation {
  runtimeId: string;
  generation: string;
  epoch: number;
  selection: number;
  controller: AbortController;
}

export class CyberShuttlePanel extends StackedPanel {
  readonly stateChanged = new Signal<this, IRuntimeUiState>(this);

  readonly header = new CyberShuttleHeader();
  private _list = new RuntimeList();
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _polling = false;
  private _polled = false;
  private _selection = 0;
  private _runtimes: IRuntime[] = [];
  private _logs = new Map<string, IRuntimeLogTail>();
  private _busyRuntimeIds = new Set<string>();
  private _startingRuntimeIds = new Set<string>();
  private _connectingRuntimeId: string | undefined;
  private _jupyterReady = new Set<string>();
  private _jupyterOperations = new Map<string, IJupyterOperation>();
  private _jupyterEpoch = 0;
  private _loading = false;
  private _updatesStatus = "";
  private _error = "";
  private _hosts: ISshHost[] | undefined;
  private _signedIn = false;
  private _signingIn = false;
  private _signInPromise: Promise<void> | undefined;
  private _authRequired = false;
  private _controlInitialized = false;
  private _createForm = (): CreateRuntimeForm =>
    new CreateRuntimeForm(this._api);
  private _detailDialog: Dialog<unknown> | undefined;
  private _sshHostsWidget = (): SshHosts => new SshHosts(this._api);

  constructor(
    private _api: ControlClient,
    private _controller: RuntimeController,
  ) {
    super();
    this.id = "cybershuttle-runtime-panel";
    this.title.label = "Remote Runtimes";
    this.title.closable = false;
    this.addClass("csShell");
    this._list.setCurrentRuntimeId(_controller.currentRuntimeId);
    this.addWidget(this._list);
    this._list.runtimeRequested.connect(
      (_sender, id) => void this.openRuntime(id),
    );
    this._list.createRequested.connect(() => void this.openCreate());
    this._list.sshHostsRequested.connect(() => void this.openSshHosts());
    this.header.signInRequested.connect(() => void this.signIn());
    this.header.signOutRequested.connect(() => this.signOut());
    this._emitState();
    void this.resume();
  }

  get currentRuntimeId(): string | undefined {
    return this._controller.currentRuntimeId;
  }

  get state(): IRuntimeUiState {
    return {
      runtimes: this._runtimes.map((runtime) => ({
        ...runtime,
        resources: { ...runtime.resources },
      })),
      logs: new Map(
        [...this._logs].map(([id, tail]) => [
          id,
          { ...tail, lines: tail.lines.map((line) => ({ ...line })) },
        ]),
      ),
      loading: this._loading,
      updatesStatus: this._updatesStatus,
      error: this._error,
      busyRuntimeIds: new Set(this._busyRuntimeIds),
      startingRuntimeIds: new Set(this._startingRuntimeIds),
      connectingRuntimeId: this._connectingRuntimeId,
      jupyterReady: new Set(this._jupyterReady),
      signedIn: this._signedIn,
      signingIn: this._signingIn,
      authRequired: this._authRequired,
      account: this._signedIn ? this._api.account : undefined,
    };
  }

  private _emitState(): void {
    const state = this.state;
    this.header.setControllerState(state);
    this._list.setControllerState(state);
    this.stateChanged.emit(state);
  }

  private _setRuntimes(runtimes: IRuntime[]): void {
    const next = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
    for (const previous of this._runtimes) {
      const runtime = next.get(previous.id);
      if (
        !runtime ||
        runtime.generation !== previous.generation ||
        this._runtimeIsTerminal(runtime)
      ) {
        this._releaseRuntime(previous.id);
      } else if (runtime.state !== "READY") {
        this._releaseJupyter(previous.id);
      }
    }
    for (const runtime of runtimes) {
      if (this._runtimeIsTerminal(runtime)) {
        this._releaseRuntime(runtime.id);
      }
    }
    this._runtimes = runtimes;
    this._emitState();
  }

  // The poll carries every tail the caller owns, so the map is replaced rather
  // than merged and a runtime that has gone away takes its tail with it.
  private _setRuntimeLogs(tails: readonly IRuntimeLogTail[]): void {
    this._logs = new Map(tails.map((tail) => [tail.runtimeId, tail]));
    this._emitState();
  }

  private _setLoading(loading: boolean): void {
    this._loading = loading;
    this._emitState();
  }

  private _setError(message: string): void {
    this._error = message;
    this._emitState();
  }

  private _setStreamStatus(message: string): void {
    this._updatesStatus = message;
    this._emitState();
  }

  private _setBusy(id: string, busy: boolean): void {
    busy ? this._busyRuntimeIds.add(id) : this._busyRuntimeIds.delete(id);
    this._emitState();
  }

  private _setConnecting(id: string | undefined): void {
    this._connectingRuntimeId = id;
    this._emitState();
  }

  private _runtime(id: string): IRuntime | undefined {
    return this._runtimes.find((runtime) => runtime.id === id);
  }

  private _releaseJupyter(id: string): void {
    this._abortJupyter(id);
    this._jupyterReady.delete(id);
  }

  private _releaseRuntime(id: string): void {
    this._cancelSelection(id);
    this._releaseJupyter(id);
    clearRuntimeAccess(id);
  }

  private _selectedRuntime(id: string): IRuntime | undefined {
    const runtime = this._runtime(id);
    if (!runtime) {
      this._setError("Runtime is no longer available.");
    }
    return runtime;
  }

  private _runtimeIsTerminal(runtime: IRuntime): boolean {
    return isTerminal(runtime.state);
  }

  private _beginJupyter(runtime: IRuntime): IJupyterOperation {
    this._abortJupyter(runtime.id);
    const operation = {
      runtimeId: runtime.id,
      generation: runtime.generation,
      epoch: ++this._jupyterEpoch,
      selection: this._selection,
      controller: new AbortController(),
    };
    this._jupyterOperations.set(runtime.id, operation);
    return operation;
  }

  private _jupyterOperationCurrent(operation: IJupyterOperation): boolean {
    const runtime = this._runtime(operation.runtimeId);
    return (
      !this.isDisposed &&
      this._jupyterOperations.get(operation.runtimeId) === operation &&
      operation.selection === this._selection &&
      !operation.controller.signal.aborted &&
      runtime?.generation === operation.generation &&
      runtime.state === "READY" &&
      !this._runtimeIsTerminal(runtime)
    );
  }

  private _cancelSelection(runtimeId: string): void {
    if (
      this._connectingRuntimeId === runtimeId ||
      this.currentRuntimeId === runtimeId
    ) {
      this._selection++;
      this._connectingRuntimeId = undefined;
    }
  }

  // Only the Jupyter operation's own busy flag is cleared here: releasing a
  // terminal card's access happens on every poll, and it used to take the
  // spinner off an action still running against that same card.
  private _abortJupyter(runtimeId: string): void {
    const operation = this._jupyterOperations.get(runtimeId);
    if (!operation) {
      return;
    }
    operation.controller.abort();
    this._jupyterOperations.delete(runtimeId);
    this._busyRuntimeIds.delete(runtimeId);
  }

  private _abortJupyterOperations(): void {
    for (const runtimeId of [...this._jupyterOperations.keys()]) {
      this._abortJupyter(runtimeId);
    }
  }

  private _finishJupyter(operation: IJupyterOperation): void {
    if (this._jupyterOperations.get(operation.runtimeId) === operation) {
      this._jupyterOperations.delete(operation.runtimeId);
    }
  }

  private _startPolling(): void {
    if (this._pollTimer !== undefined) {
      return;
    }
    void this._poll();
    this._pollTimer = setInterval(
      () => void this._poll(),
      RUNTIME_POLL_INTERVAL_MS,
    );
  }

  private _stopPolling(): void {
    if (this._pollTimer !== undefined) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  // cs-control answers from its own state and starts a reconciliation for the
  // next poll, so this never waits on SSH.
  private async _poll(): Promise<void> {
    if (this._polling || this.isDisposed) {
      return;
    }
    this._polling = true;
    try {
      const list = await this._api.listRuntimes();
      if (this.isDisposed) {
        return;
      }
      this._polled = true;
      this._setRuntimes(list.runtimes);
      this._setRuntimeLogs(list.logs);
      for (const runtime of list.runtimes) {
        if (
          runtime.state === "READY" &&
          !this._jupyterReady.has(runtime.id) &&
          !this._jupyterOperations.has(runtime.id)
        ) {
          void this.refreshJupyter(runtime.id);
        }
      }
      this._emitState();
      this._setStreamStatus("");
    } catch (error) {
      if (this.isDisposed) {
        return;
      }
      if (error instanceof AuthInteractionRequiredError) {
        this._requireAuthentication();
        return;
      }
      this._setStreamStatus("Runtime updates unavailable.");
    } finally {
      this._polling = false;
    }
  }

  signIn(): Promise<void> {
    if (!this._signInPromise) {
      this._signingIn = true;
      this._setError("");
      this._emitState();
      this._signInPromise = this._signIn().finally(() => {
        this._signingIn = false;
        this._signInPromise = undefined;
        if (!this.isDisposed) this._emitState();
      });
    }
    return this._signInPromise;
  }

  private async _signIn(): Promise<void> {
    try {
      await this._api.signIn();
      if (this.isDisposed) return;
      await this._activateSession();
    } catch (error) {
      if (!this.isDisposed) {
        if (error instanceof AuthInteractionRequiredError)
          this._requireAuthentication();
        else this._setError(errorMessage(error));
      }
    }
  }

  // Signing out has to take the cached Jupyter credentials with it: they grant
  // code execution on the allocation and would otherwise outlive the session
  // that authorised them.
  signOut(): void {
    for (const runtime of this._runtimes) {
      clearRuntimeAccess(runtime.id);
    }
    this._api.signOut();
    this._stopPolling();
    this._signedIn = false;
    this._authRequired = false;
    this._controlInitialized = false;
    this._polled = false;
    this._runtimes = [];
    this._hosts = undefined;
    this._logs = new Map();
    this._jupyterReady = new Set();
    this._updatesStatus = "";
    this._error = "";
    this._emitState();
  }

  private async _activateSession(): Promise<void> {
    this._signedIn = true;
    this._authRequired = false;
    this._setStreamStatus("");
    this._startPolling();
    if (!this._controlInitialized) {
      this._controlInitialized = true;
      await this._initialize();
    }
  }

  // A credential restored from the previous page is already a live session:
  // without this the header offers a sign-in the browser does not need and
  // runtime polling never starts.
  async resume(): Promise<void> {
    try {
      await this._api.resumeSession();
    } catch {
      return;
    }
    if (!this.isDisposed) await this._activateSession();
  }

  private _requireAuthentication(): void {
    if (this.isDisposed) return;
    this._authRequired = true;
    this._stopPolling();
    this._setStreamStatus("Sign in again to resume runtime updates.");
  }

  private async _initialize(): Promise<void> {
    this._setLoading(true);
    try {
      const [list] = await Promise.all([
        this._api.listRuntimes(),
        this._refreshHosts(),
      ]);
      if (!this._polled && !this.isDisposed) {
        this._setRuntimes(list.runtimes);
        this._setRuntimeLogs(list.logs);
      }
    } catch (error) {
      this._setError(errorMessage(error));
    } finally {
      this._setLoading(false);
    }
  }

  dispose(): void {
    this._selection++;
    this._abortJupyterOperations();
    this._setConnecting(undefined);
    this._stopPolling();
    super.dispose();
  }

  private async _refreshHosts(): Promise<void> {
    try {
      const hosts = await this._api.listSshHosts();
      this._hosts = hosts;
      this._error = "";
      this._emitState();
      this._list.setCanCreate(
        hosts.length > 0,
        hosts.length ? "" : "Add an SSH host before creating a runtime.",
      );
    } catch (error) {
      if (this._hosts === undefined) {
        this._list.setCanCreate(
          false,
          "SSH hosts are temporarily unavailable.",
        );
      }
      this._setError(errorMessage(error));
    }
  }

  async openRuntime(runtimeId: string): Promise<void> {
    const body = new RuntimeDetail(this, runtimeId);
    body.addClass("csWorkspaceModal");
    const dialog = new Dialog({
      title: "CyberShuttle Runtime",
      body,
      buttons: [Dialog.cancelButton({ label: "Close" })],
    });
    this._detailDialog = dialog;
    try {
      await dialog.launch().catch(() => undefined);
    } finally {
      this._detailDialog = undefined;
    }
  }

  // A READY runtime already runs Jupyter, so "refresh" only means fetching the owner-scoped
  // access cs-control issues for it.
  async refreshJupyter(runtimeId: string): Promise<boolean> {
    const runtime = this._runtime(runtimeId);
    if (!runtime || runtime.state !== "READY") {
      return false;
    }
    const operation = this._beginJupyter(runtime);
    try {
      await this._ensureAccess(runtime, operation);
      return this._jupyterReady.has(runtime.id);
    } catch (error) {
      if (!this._jupyterOperationCurrent(operation)) return false;
      if (!isAbortError(error)) this._setError(errorMessage(error));
      return false;
    } finally {
      this._finishJupyter(operation);
    }
  }

  private async _ensureAccess(
    runtime: IRuntime,
    operation: IJupyterOperation,
  ): Promise<void> {
    if (!loadRuntimeAccess(runtime.id, runtime.generation)) {
      const access = await this._api.getRuntimeAccess(runtime.id);
      if (!this._jupyterOperationCurrent(operation)) return;
      if (access.generation !== operation.generation) {
        throw new Error("Runtime access generation changed.");
      }
      cacheRuntimeAccess(access);
    }
    if (!this._jupyterOperationCurrent(operation)) return;
    this._jupyterReady.add(runtime.id);
    this._emitState();
  }

  private async _ensureJupyter(runtime: IRuntime): Promise<void> {
    const operation = this._beginJupyter(runtime);
    this._setBusy(runtime.id, true);
    try {
      await this._ensureAccess(runtime, operation);
    } catch (error) {
      if (!this._jupyterOperationCurrent(operation)) return;
      clearRuntimeAccess(runtime.id);
      if (!isAbortError(error)) throw error;
    } finally {
      if (this._jupyterOperations.get(runtime.id) === operation) {
        this._finishJupyter(operation);
        this._setBusy(runtime.id, false);
      }
    }
  }

  async connect(runtimeId: string): Promise<void> {
    const runtime = this._selectedRuntime(runtimeId);
    if (!runtime) {
      return;
    }
    const selection = ++this._selection;
    this._abortJupyterOperations();
    const current = (): boolean =>
      selection === this._selection && !this.isDisposed;
    this._setError("");
    this._setConnecting(runtime.id);
    try {
      await this._ensureJupyter(runtime);
      if (current()) await this._controller.select(runtime.id, current);
    } catch (error) {
      if (current()) {
        this._setError(errorMessage(error));
      }
    } finally {
      if (current()) {
        this._setConnecting(undefined);
      }
    }
  }

  async runAgain(runtimeId: string): Promise<void> {
    if (this._startingRuntimeIds.has(runtimeId)) {
      return;
    }
    this._startingRuntimeIds.add(runtimeId);
    try {
      await this._act(runtimeId, (id) => this._api.startRuntime(id));
    } finally {
      this._startingRuntimeIds.delete(runtimeId);
      this._emitState();
    }
  }

  async stop(runtimeId: string): Promise<void> {
    await this._act(runtimeId, (id) => this._api.stopRuntime(id));
  }

  private async _act(
    runtimeId: string,
    act: (id: string) => Promise<IRuntime>,
  ): Promise<void> {
    const runtime = this._selectedRuntime(runtimeId);
    if (!runtime) {
      return;
    }
    this._setError("");
    this._releaseRuntime(runtime.id);
    this._setBusy(runtime.id, true);
    try {
      // The answer is newer than the last poll, so the card follows it rather
      // than showing the state it was in until the next read a second later.
      const acted = await act(runtime.id);
      this._runtimes = this._runtimes.map((each) =>
        each.id === acted.id ? acted : each,
      );
    } catch (error) {
      this._setError(errorMessage(error));
    } finally {
      this._setBusy(runtime.id, false);
    }
  }

  // Deleting a live allocation cancels its job, so the confirmation names what
  // is actually lost rather than asking a generic "are you sure".
  async remove(runtimeId: string): Promise<void> {
    const runtime = this._selectedRuntime(runtimeId);
    if (!runtime) {
      return;
    }
    const live = !isTerminal(runtime.state);
    // JupyterLab shows one dialog at a time, so a confirmation raised from the
    // open detail modal would queue behind it and never reach the owner.
    this._detailDialog?.resolve(0);
    const confirmed = await showDialog({
      title: "Delete runtime",
      body: live
        ? `${runtime.rootFolder} on ${runtime.sshHost} is ${runtime.state.toLowerCase()}. Deleting it cancels the Slurm job and removes the card.`
        : `Remove ${runtime.rootFolder} on ${runtime.sshHost} from this list? Its allocation has already ended.`,
      buttons: [
        Dialog.cancelButton({ label: "Cancel" }),
        Dialog.warnButton({ label: "Delete" }),
      ],
    });
    if (!confirmed.button.accept || this.isDisposed) {
      return;
    }
    this._setError("");
    this._releaseRuntime(runtime.id);
    this._setBusy(runtime.id, true);
    try {
      await this._api.deleteRuntime(runtime.id);
      this._runtimes = this._runtimes.filter((each) => each.id !== runtime.id);
      this._emitState();
    } catch (error) {
      this._setError(errorMessage(error));
    } finally {
      this._setBusy(runtime.id, false);
    }
  }

  // Each modal is one view titled after it, closed by the dialog's own control:
  // no footer repeats that, and the view's own action sits where a footer would.
  async openCreate(): Promise<void> {
    const body = new Panel();
    body.addClass("csWorkspaceModal");
    const form = this._createForm();
    body.addWidget(form);
    form.setHosts(this._hosts ?? []);
    const dialog = new Dialog({
      title: "Add Runtime",
      body,
      buttons: [],
      hasClose: true,
    });
    const show = (widget: Widget): void => {
      for (const child of body.widgets) {
        child === widget ? child.show() : child.hide();
      }
      widget.activate();
    };
    form.sshHostsRequested.connect(() => {
      dialog.reject();
      void this.openSshHosts();
    });
    form.createRequested.connect((_sender, intent) => {
      void this._createInModal(intent, form, body, show);
    });
    show(form);
    await dialog.launch().catch(() => undefined);
  }

  async openSshHosts(): Promise<void> {
    const hosts = this._sshHostsWidget();
    hosts.addClass("csWorkspaceModal");
    void hosts.refresh();
    await new Dialog({
      title: "SSH Hosts",
      body: hosts,
      buttons: [],
      hasClose: true,
    })
      .launch()
      .catch(() => undefined);
  }

  private async _createInModal(
    allocation: IRuntimeCreateRequest,
    form: CreateRuntimeForm,
    body: Panel,
    show: (widget: Widget) => void,
  ): Promise<void> {
    form.setError("");
    form.setBusy(true);
    try {
      const runtime = await this._api.createRuntime(allocation);
      if (body.isDisposed || form.isDisposed) {
        return;
      }
      form.resetRequestIdentity();
      const detail = new RuntimeDetail(this, runtime.id);
      body.addWidget(detail);
      show(detail);
    } catch (error) {
      if (!form.isDisposed) {
        form.setError(errorMessage(error));
      }
    } finally {
      if (!form.isDisposed) {
        form.setBusy(false);
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
