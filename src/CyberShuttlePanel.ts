import { Dialog, showDialog } from "@jupyterlab/apputils";
import { Signal } from "@lumino/signaling";
import { Panel, StackedPanel, Widget } from "@lumino/widgets";
import { AuthInteractionRequiredError } from "./AuthClient";
import { CreateRuntimeForm } from "./CreateRuntimeForm";
import {
  IMetricSample,
  IRun,
  IRuntime,
  IRuntimeCreateRequest,
  ISshHost,
  isTerminal,
} from "./Common";
import {
  ControlClient,
  errorMessage,
  IRuntimeLogTail,
  needsSshLogin,
  UNCHANGED,
} from "./ControlClient";
import { SshLoginDock } from "./SshLoginDock";
import { RuntimeController } from "./RuntimeController";
import { RuntimeDetail } from "./RuntimeDetail";
import {
  cacheRuntimeAccess,
  clearRuntimeAccess,
  loadRuntimeAccess,
} from "./runtime-access";
import { CyberShuttleHeader, RuntimeList } from "./RuntimeList";
import { RunHistory } from "./RunHistory";
import { SshHosts } from "./SshHosts";

/** cs-control caps its own SSH work at this rate, so polling faster would only
 * add HTTP round trips. */
const RUNTIME_POLL_INTERVAL_MS = 1000;

export interface IRuntimeUiState {
  readonly runtimes: readonly IRuntime[];
  readonly logs: ReadonlyMap<string, IRuntimeLogTail>;
  readonly samples: ReadonlyMap<string, readonly IMetricSample[]>;
  readonly runs: readonly IRun[];
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly busyRuntimeIds: ReadonlySet<string>;
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
  private _list: RuntimeList;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _polling = false;
  private _selection = 0;
  private _runtimes: IRuntime[] = [];
  private _logs = new Map<string, IRuntimeLogTail>();
  // Samples are their own read, so they are held beside the list rather than in
  // it, and only for the runtime whose detail is open.
  private _samples = new Map<string, IMetricSample[]>();
  private _watchedRuntimeId: string | undefined;
  // The history outlives the runtimes in it, so it is read as its own thing
  // rather than derived from the list.
  private _runs: IRun[] = [];
  // Deletes waiting on the scheduler to release their job.
  private _pendingDeletes = new Set<string>();
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
  private _loginDock: SshLoginDock | undefined;
  private _sshHostsWidget = (): SshHosts => new SshHosts(this._api);
  private _runHistoryWidget = (): RunHistory => new RunHistory(this._api);
  private _loginDockWidget = (): SshLoginDock => new SshLoginDock();

  constructor(
    private _api: ControlClient,
    private _controller: RuntimeController,
  ) {
    super();
    this.id = "cybershuttle-runtime-panel";
    this.title.label = "Remote Runtimes";
    this.title.closable = false;
    this.addClass("csShell");
    this._list = new RuntimeList(_controller.currentRuntimeId);
    this.addWidget(this._list);
    this._list.runtimeRequested.connect(
      (_sender, id) => void this.openRuntime(id),
    );
    this._list.createRequested.connect(() => void this.openCreate());
    this._list.sshHostsRequested.connect(() => void this.openSshHosts());
    this._list.runHistoryRequested.connect(() => void this.openRunHistory());
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
      // A card being run again starts from the click, not from the poll that
      // first sees it, and only while that request is in flight.
      runtimes: this._runtimes.map((runtime) => ({
        ...runtime,
        state: this._startingRuntimeIds.has(runtime.id)
          ? "SUBMITTING"
          : runtime.state,
      })),
      logs: this._logs,
      samples: this._samples,
      runs: this._runs,
      loading: this._loading,
      updatesStatus: this._updatesStatus,
      error: this._error,
      busyRuntimeIds: new Set(this._busyRuntimeIds),
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

  // Every emit rebuilds both widget subtrees, so an unchanged read renders
  // nothing.
  private _setRuntimes(runtimes: IRuntime[]): void {
    if (JSON.stringify(runtimes) === JSON.stringify(this._runtimes)) {
      return;
    }
    const next = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
    for (const previous of this._runtimes) {
      const runtime = next.get(previous.id);
      if (
        !runtime ||
        runtime.generation !== previous.generation ||
        isTerminal(runtime.state)
      ) {
        this._releaseRuntime(previous.id);
      } else if (runtime.state !== "READY") {
        this._releaseJupyter(previous.id);
      }
    }
    for (const runtime of runtimes) {
      if (isTerminal(runtime.state)) {
        this._releaseRuntime(runtime.id);
      }
    }
    this._runtimes = runtimes;
    this._emitState();
  }

  // The poll carries every tail the caller owns, so the map is replaced rather
  // than merged: a runtime that has gone away takes its tail with it.
  private _setRuntimeLogs(tails: readonly IRuntimeLogTail[]): void {
    if (JSON.stringify(tails) === JSON.stringify([...this._logs.values()])) {
      return;
    }
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
    if (this._updatesStatus === message) {
      return;
    }
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
      !isTerminal(runtime.state)
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

  // Only this operation's busy flag: releasing a terminal card's access must not
  // take an unrelated action's spinner with it.
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

  private _stopPolling(): void {
    if (this._pollTimer !== undefined) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  // cs-control answers from its own state, so this never waits on SSH.
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
      if (list !== UNCHANGED) {
        this._setRuntimes(list.runtimes);
        this._setRuntimeLogs(list.logs);
      }
      await Promise.all([this._pollSamples(), this._pollRuns()]);
      await this._retryPendingDeletes();
      // An unchanged list still runs this: a getRuntimeAccess that failed once
      // would otherwise never be retried while the list sits settled.
      for (const runtime of this._runtimes) {
        if (
          runtime.state === "READY" &&
          !this._jupyterReady.has(runtime.id) &&
          !this._jupyterOperations.has(runtime.id)
        ) {
          void this.refreshJupyter(runtime.id);
        }
      }
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

  // Only the runtime being looked at is sampled: cs-control keeps a window for
  // every allocation, but reading one nobody is watching is a round trip for a
  // graph nobody sees.
  watchSamples(runtimeId: string | undefined): void {
    this._watchedRuntimeId = runtimeId;
    if (runtimeId === undefined) {
      return;
    }
    void this._pollSamples();
  }

  // A run appears only when an allocation ends, so this rides the poll it is
  // already making rather than taking a timer of its own.
  private async _pollRuns(): Promise<void> {
    try {
      const runs = await this._api.listRuns();
      if (
        this.isDisposed ||
        JSON.stringify(runs) === JSON.stringify(this._runs)
      ) {
        return;
      }
      this._runs = runs;
      this._emitState();
    } catch {
      // History that could not be read leaves the last one in place.
    }
  }

  private async _pollSamples(): Promise<void> {
    const runtimeId = this._watchedRuntimeId;
    if (runtimeId === undefined) {
      return;
    }
    try {
      const series = await this._api.getRuntimeMetrics(runtimeId);
      if (this.isDisposed || this._watchedRuntimeId !== runtimeId) {
        return;
      }
      const previous = this._samples.get(runtimeId);
      if (JSON.stringify(previous) === JSON.stringify(series.samples)) {
        return;
      }
      this._samples.set(runtimeId, series.samples);
      this._emitState();
    } catch {
      // A window that could not be read is a gap in a graph, not a failure of
      // the panel: the list and its actions are unaffected.
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

  // The cached Jupyter credentials grant code execution on the allocation, so
  // they must not outlive the session that authorised them.
  signOut(): void {
    for (const runtime of this._runtimes) {
      clearRuntimeAccess(runtime.id);
    }
    this._api.signOut();
    this._stopPolling();
    this._signedIn = false;
    this._authRequired = false;
    this._controlInitialized = false;
    this._runtimes = [];
    this._hosts = undefined;
    this._logs = new Map();
    this._samples = new Map();
    this._watchedRuntimeId = undefined;
    this._runs = [];
    this._pendingDeletes = new Set();
    this._jupyterReady = new Set();
    this._updatesStatus = "";
    this._error = "";
    this._emitState();
  }

  // Trade-off: the first poll is the bootstrap read; add a separate initial
  // fetch only if the poll ever stops returning the full list.
  private async _activateSession(): Promise<void> {
    this._signedIn = true;
    this._authRequired = false;
    this._setStreamStatus("");
    this._pollTimer ??= setInterval(
      () => void this._poll(),
      RUNTIME_POLL_INTERVAL_MS,
    );
    if (this._controlInitialized) {
      void this._poll();
      return;
    }
    this._controlInitialized = true;
    this._setLoading(true);
    await Promise.all([this._poll(), this._refreshHosts()]);
    this._setLoading(false);
  }

  // A credential restored from the previous page is already a live session, so
  // without this the header offers a sign-in the browser does not need.
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
    this.watchSamples(runtimeId);
    const body = new Panel();
    body.addClass("csWorkspaceModal");
    body.addWidget(new RuntimeDetail(this, runtimeId));
    const dialog = new Dialog({
      title: "CyberShuttle Runtime",
      body,
      buttons: [Dialog.cancelButton({ label: "Close" })],
    });
    this._detailDialog = dialog;
    const dock = this._loginDockWidget();
    body.addWidget(dock);
    this._loginDock = dock;
    try {
      await dialog.launch().catch(() => undefined);
    } finally {
      this.watchSamples(undefined);
      this._detailDialog = undefined;
      this._loginDock = undefined;
      dock.dispose();
    }
  }

  // The retry sits outside the try, so a host that refuses again reports that
  // refusal rather than starting a second login.
  private async _overSsh<T>(
    alias: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!this._loginDock || !needsSshLogin(error)) {
        throw error;
      }
      await this._loginDock.login(alias, this._api.sshAuthWebSocket(alias));
      return action();
    }
  }

  // A READY runtime already runs Jupyter, so this only fetches the owner-scoped
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

  // Stopping cancels the Slurm job, which is as destructive as deleting the card
  // and was the one verb that did it without asking.
  async stop(runtimeId: string): Promise<void> {
    const runtime = this._selectedRuntime(runtimeId);
    if (!runtime) {
      return;
    }
    // JupyterLab shows one dialog at a time, so a confirmation raised from the
    // open detail modal would queue behind it and never reach the owner.
    this._detailDialog?.resolve(0);
    const confirmed = await showDialog({
      title: "Stop runtime",
      body: `Cancels the Slurm job on ${runtime.sshHost}. Anything unsaved in this runtime's kernels and terminals is lost.`,
      buttons: [
        Dialog.cancelButton({ label: "Cancel" }),
        Dialog.warnButton({ label: "Stop" }),
      ],
    });
    if (!confirmed.button.accept || this.isDisposed) {
      return;
    }
    await this._act(runtimeId, (id) => this._api.stopRuntime(id));
  }

  private async _act(
    runtimeId: string,
    act: (id: string) => Promise<IRuntime>,
    apply: (acted: IRuntime) => IRuntime[] = (acted) =>
      this._runtimes.map((each) => (each.id === acted.id ? acted : each)),
  ): Promise<void> {
    const runtime = this._selectedRuntime(runtimeId);
    if (!runtime) {
      return;
    }
    this._setError("");
    this._releaseRuntime(runtime.id);
    this._setBusy(runtime.id, true);
    try {
      // Newer than the last poll, so the card follows it rather than the read.
      const acted = await this._overSsh(runtime.sshHost, () => act(runtime.id));
      this._runtimes = apply(acted);
    } catch (error) {
      this._setError(errorMessage(error));
    } finally {
      this._setBusy(runtime.id, false);
    }
  }

  // Deleting a live allocation cancels its job, so the confirmation names what
  // is lost.
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
    // cs-control stops first and then refuses until the scheduler has released
    // the job, which for a live allocation is almost never the same instant. The
    // intent is kept and retried rather than handed back as a second click.
    try {
      await this._act(
        runtimeId,
        (id) => this._api.deleteRuntime(id),
        () => this._runtimes.filter((each) => each.id !== runtime.id),
      );
    } finally {
      if (this._runtimes.some((each) => each.id === runtimeId)) {
        this._pendingDeletes.add(runtimeId);
        this._emitState();
      }
    }
  }

  // Retried on the poll that first sees the job released. A pending delete is
  // deliberately not persisted: it is an intent for this page, and a reload is
  // the owner changing their mind.
  private async _retryPendingDeletes(): Promise<void> {
    for (const runtimeId of [...this._pendingDeletes]) {
      const runtime = this._runtimes.find((each) => each.id === runtimeId);
      if (!runtime) {
        this._pendingDeletes.delete(runtimeId);
        continue;
      }
      if (!isTerminal(runtime.state)) {
        continue;
      }
      this._pendingDeletes.delete(runtimeId);
      await this._act(
        runtimeId,
        (id) => this._api.deleteRuntime(id),
        () => this._runtimes.filter((each) => each.id !== runtimeId),
      );
    }
  }

  // Each modal is one view titled after it and closed by the dialog's own
  // control, with the view's own action where a footer would be.
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

  async openRunHistory(): Promise<void> {
    const history = this._runHistoryWidget();
    history.addClass("csWorkspaceModal");
    void history.refresh();
    await new Dialog({
      title: "Run History",
      body: history,
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
