// The stateful controller behind the launcher panel: polls cs-control, holds
// session/run/log state and the sign-in state machine, and renders the title
// row's sign-in status. It composes actions and modals rather than owning
// their logic, and replaces log tails wholly each poll rather than merging.
import { Signal } from "@lumino/signaling";
import { StackedPanel } from "@lumino/widgets";
import {
  errorMessage,
  IMetricSample,
  IRun,
  ISession,
  ISshHost,
  isTerminal,
  type SignInProvider,
} from "./Common";
import { AuthInteractionRequiredError } from "./AuthClient";
import { ControlClient, ISessionLogTail, UNCHANGED } from "./ControlClient";
import { RebuildingWidget } from "./RebuildingWidget";
import { SessionController } from "./SessionController";
import {
  clearSessionAccess,
  emptyState,
  getActiveSessionId,
  type ISessionUiState,
} from "./session";
import { SessionActions } from "./session-actions";
import { SessionList } from "./SessionList";
import { SessionModals } from "./modals";
import { button, element } from "./dom";

const SESSION_POLL_INTERVAL_MS = 1000;

export class CyberShuttleHeader extends RebuildingWidget {
  readonly signInRequested = new Signal<this, SignInProvider>(this);
  readonly signOutRequested = new Signal<this, void>(this);
  readonly sshKeysRequested = new Signal<this, void>(this);

  private _state = emptyState();
  private _accountMenuOpen = false;

  constructor() {
    super();
    this.addClass("csSessionHeaderWidget");
    this._render();
  }

  setState(state: ISessionUiState): void {
    this._state = state;
    this._render();
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const header = element(
      "header",
      "",
      "jp-Launcher-sectionHeader csSessionLauncherHeader",
    );
    const title = element("h2", "CyberShuttle", "jp-Launcher-sectionTitle");
    header.append(
      element("div", "", "csSessionSectionIcon"),
      title,
      this._identityControl(),
    );
    this.node.appendChild(header);
  }

  private _identityControl(): HTMLElement {
    const holder = element("div", "", "csIdentity");
    const { signedIn, signingIn, account } = this._state;
    const trigger = button(
      "",
      `csTextButton csIdentityButton ${signedIn ? "csAccountButton" : "csSignInButton"}`,
    );
    trigger.append(
      userGlyph(),
      element(
        "span",
        signedIn
          ? (account ?? "Account")
          : signingIn
            ? "Signing in…"
            : "Sign in",
      ),
    );
    trigger.dataset.sessionAction = signedIn ? "account" : "sign-in";
    trigger.disabled = signingIn;
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", String(this._accountMenuOpen));
    trigger.onclick = () => {
      this._accountMenuOpen = !this._accountMenuOpen;
      this._render();
    };
    holder.appendChild(trigger);
    if (this._accountMenuOpen) {
      const menu = element("div", "", "csAccountMenu", { role: "menu" });
      menu.append(
        ...(signedIn
          ? [
              this._menuItem("SSH Keys", "ssh-keys", KEY_GLYPH, () =>
                this.sshKeysRequested.emit(undefined),
              ),
              this._menuItem("Sign out", "sign-out", SIGN_OUT_GLYPH, () =>
                this.signOutRequested.emit(undefined),
              ),
            ]
          : [
              this._menuItem(
                "Microsoft",
                "sign-in-microsoft",
                MICROSOFT_GLYPH,
                () => this.signInRequested.emit("microsoft"),
              ),
              this._menuItem("GitHub", "sign-in-github", GITHUB_GLYPH, () =>
                this.signInRequested.emit("github"),
              ),
            ]),
      );
      holder.appendChild(menu);
    }
    return holder;
  }

  private _menuItem(
    label: string,
    action: string,
    glyph: string,
    choose: () => void,
  ): HTMLButtonElement {
    const item = button("", "csAccountMenuItem");
    item.innerHTML = glyph;
    item.appendChild(element("span", label));
    item.dataset.sessionAction = action;
    item.setAttribute("role", "menuitem");
    item.onclick = () => {
      this._accountMenuOpen = false;
      choose();
    };
    return item;
  }
}

const MICROSOFT_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="2.5" y="2.5" width="6.8" height="6.8" /><rect x="10.7" y="2.5" width="6.8" height="6.8" /><rect x="2.5" y="10.7" width="6.8" height="6.8" /><rect x="10.7" y="10.7" width="6.8" height="6.8" /></g></svg>`;
const GITHUB_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>`;

const KEY_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="10" r="3.6" /><path d="M10.6 10h7.2M15.2 10v2.6M17.8 10v2" /></g></svg>`;
const SIGN_OUT_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5H4.5v13H8M12.5 6.5 16 10l-3.5 3.5M16 10H7.5" /></g></svg>`;

function userGlyph(): SVGSVGElement {
  const holder = element("div", "");
  holder.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="10" cy="10" r="8.6" /><circle cx="10" cy="8.2" r="2.6" /><path d="M5.3 16.5a5 5 0 0 1 9.4 0" /></g></svg>`;
  return holder.firstElementChild as SVGSVGElement;
}

interface ISignInHooks {
  isDisposed: () => boolean;
  emitState: () => void;
  activate: () => Promise<void>;
  stopPolling: () => void;
  setUpdatesStatus: (message: string) => void;
  onError: (message: string) => void;
}

class SignInController {
  private _signedIn = false;
  private _signingIn = false;
  private _signInPromise: Promise<void> | undefined;

  constructor(
    private _api: ControlClient,
    private _hooks: ISignInHooks,
  ) {}

  get signedIn(): boolean {
    return this._signedIn;
  }

  get signingIn(): boolean {
    return this._signingIn;
  }

  get account(): string | undefined {
    return this._signedIn ? this._api.account : undefined;
  }

  signIn(provider?: SignInProvider): Promise<void> {
    if (!this._signInPromise) {
      this._signingIn = true;
      this._hooks.onError("");
      this._hooks.emitState();
      this._signInPromise = this._signIn(provider).finally(() => {
        this._signingIn = false;
        this._signInPromise = undefined;
        if (!this._hooks.isDisposed()) this._hooks.emitState();
      });
    }
    return this._signInPromise;
  }

  private async _signIn(provider?: SignInProvider): Promise<void> {
    try {
      await this._api.signIn(provider);
      if (this._hooks.isDisposed()) return;
      await this._activate();
    } catch (error) {
      if (!this._hooks.isDisposed()) {
        if (error instanceof AuthInteractionRequiredError) {
          this.requireAuthentication();
        } else {
          this._hooks.onError(errorMessage(error));
        }
      }
    }
  }

  signOut(): void {
    this._api.signOut();
    this._hooks.stopPolling();
    this._signedIn = false;
  }

  async resume(): Promise<void> {
    try {
      await this._api.resumeSignIn();
    } catch {
      return;
    }
    if (!this._hooks.isDisposed()) await this._activate();
  }

  requireAuthentication(): void {
    if (this._hooks.isDisposed()) return;
    this._signedIn = false;
    this._hooks.stopPolling();
    this._hooks.setUpdatesStatus("Sign in again to resume session updates.");
  }

  private async _activate(): Promise<void> {
    this._signedIn = true;
    await this._hooks.activate();
  }
}

export class CyberShuttlePanel extends StackedPanel {
  readonly stateChanged = new Signal<this, ISessionUiState>(this);

  readonly header = new CyberShuttleHeader();
  private _list: SessionList;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _polling = false;
  private _sessions: ISession[] = [];
  private _logs = new Map<string, ISessionLogTail>();
  private _samples = new Map<string, IMetricSample[]>();
  private _runs: IRun[] = [];
  private _loading = false;
  private _updatesStatus = "";
  private _error = "";
  private _hosts: ISshHost[] | undefined;
  private _signedInEpoch = 0;
  private _hostsError: string | undefined;
  private _auth: SignInController;
  private _modals: SessionModals;
  private _actions: SessionActions;

  constructor(
    private _api: ControlClient,
    private _controller: SessionController,
  ) {
    super();
    this.id = "cybershuttle-session-panel";
    this.addClass("csShell");
    this._auth = new SignInController(_api, {
      isDisposed: () => this.isDisposed,
      emitState: () => this._emitState(),
      activate: () => this._activateSignIn(),
      stopPolling: () => this._stopPolling(),
      setUpdatesStatus: (message) => this._setUpdatesStatus(message),
      onError: (message) => (this._error = message),
    });
    this._actions = new SessionActions(_api, {
      isDisposed: () => this.isDisposed,
      emitState: () => this._emitState(),
      onError: (message) => (this._error = message),
      sessions: () => this._sessions,
      replaceSessions: (sessions) => (this._sessions = sessions),
      currentSessionId: () => getActiveSessionId(),
      select: (sessionId, current) =>
        this._controller.select(sessionId, current),
      loginDock: () => this._modals.loginDock,
      rejectDetail: () => this._modals.rejectDetail(),
    });
    this._modals = new SessionModals(this, _api);
    this._list = new SessionList();
    this.addWidget(this._list);
    this._list.sessionRequested.connect(
      (_sender, id) => void this._modals.openSession(id),
    );
    this._list.createRequested.connect(() => void this.openCreate());
    this._list.sshHostsRequested.connect(() => void this.openSshHosts());
    this._list.runHistoryRequested.connect(
      () => void this._modals.openRunHistory(),
    );
    this.header.signInRequested.connect(
      (_sender, provider) => void this.signIn(provider),
    );
    this.header.signOutRequested.connect(() => this.signOut());
    this.header.sshKeysRequested.connect(() => void this._modals.openSshKeys());
    this._emitState();
    void this.resume();
  }

  get state(): ISessionUiState {
    return {
      sessions: this._sessions,
      logs: this._logs,
      samples: this._samples,
      runs: this._runs,
      loading: this._loading,
      updatesStatus: this._updatesStatus,
      error: this._error,
      busySessionIds: this._actions.busySessionIds,
      connectingSessionId: this._actions.connectingSessionId,
      jupyterReady: new Set(this._actions.jupyterReady),
      signedIn: this._auth.signedIn,
      signingIn: this._auth.signingIn,
      account: this._auth.account,
    };
  }

  private _emitState(): void {
    const state = this.state;
    this.header.setState(state);
    this._list.setState(state);
    this.stateChanged.emit(state);
  }

  private _setSessions(sessions: ISession[]): void {
    if (unchanged(sessions, this._sessions)) {
      return;
    }
    const next = new Map(sessions.map((session) => [session.id, session]));
    for (const previous of this._sessions) {
      const session = next.get(previous.id);
      if (!session || session.seq !== previous.seq) {
        this._actions.releaseSession(previous.id);
      } else if (session.state !== "READY") {
        this._actions.releaseJupyter(previous.id);
      }
    }
    for (const session of sessions) {
      if (isTerminal(session.state)) {
        this._actions.releaseSession(session.id);
      }
    }
    this._sessions = sessions;
    this._emitState();
  }

  private _setSessionLogs(tails: readonly ISessionLogTail[]): void {
    if (unchanged(tails, [...this._logs.values()])) {
      return;
    }
    this._logs = new Map(tails.map((tail) => [tail.sessionId, tail]));
    this._emitState();
  }

  private _setUpdatesStatus(message: string): void {
    if (this._updatesStatus === message) {
      return;
    }
    this._updatesStatus = message;
    this._emitState();
  }

  private _stopPolling(): void {
    if (this._pollTimer !== undefined) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private _stale(epoch: number): boolean {
    return this.isDisposed || epoch !== this._signedInEpoch;
  }

  private async _poll(): Promise<void> {
    if (this._polling || this.isDisposed) {
      return;
    }
    this._polling = true;
    const epoch = this._signedInEpoch;
    try {
      const list = await this._api.listSessions();
      if (this._stale(epoch)) {
        return;
      }
      if (list !== UNCHANGED) {
        this._setSessions(list.sessions);
        this._setSessionLogs(list.logs);
      }
      await Promise.all([this._pollSamples(epoch), this._pollRuns(epoch)]);
      if (this._stale(epoch)) {
        return;
      }
      await this._actions.retryPendingDeletes();
      if (this._stale(epoch)) {
        return;
      }
      for (const session of this._sessions) {
        if (
          session.state === "READY" &&
          !this._actions.jupyterReady.has(session.id) &&
          !this._actions.hasJupyterOperation(session.id)
        ) {
          void this._actions.refreshJupyter(session.id);
        }
      }
      this._setUpdatesStatus("");
    } catch (error) {
      if (this._stale(epoch)) {
        return;
      }
      if (error instanceof AuthInteractionRequiredError) {
        this._auth.requireAuthentication();
        return;
      }
      this._setUpdatesStatus("Session updates unavailable.");
    } finally {
      this._polling = false;
    }
  }

  private async _pollRuns(epoch: number): Promise<void> {
    try {
      const runs = await this._api.listRuns();
      if (this._stale(epoch) || unchanged(runs, this._runs)) {
        return;
      }
      this._runs = runs;
      this._emitState();
    } catch {}
  }

  private async _pollSamples(epoch: number): Promise<void> {
    const live = this._sessions.filter((session) => !isTerminal(session.state));
    await Promise.all(
      live.map((session) => this._pollSample(session.id, epoch)),
    );
    if (this._stale(epoch)) {
      return;
    }
    let changed = false;
    for (const id of [...this._samples.keys()]) {
      if (!live.some((session) => session.id === id)) {
        this._samples.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._emitState();
    }
  }

  private async _pollSample(sessionId: string, epoch: number): Promise<void> {
    try {
      const series = await this._api.getSessionMetrics(sessionId);
      if (this._stale(epoch)) {
        return;
      }
      const previous = this._samples.get(sessionId);
      if (unchanged(previous, series.samples)) {
        return;
      }
      this._samples.set(sessionId, series.samples);
      this._emitState();
    } catch {}
  }

  signIn(provider?: SignInProvider): Promise<void> {
    return this._auth.signIn(provider);
  }

  signOut(): void {
    this._signedInEpoch++;
    for (const session of this._sessions) {
      clearSessionAccess(session.id);
    }
    this._auth.signOut();
    this._actions.dispose();
    this._sessions = [];
    this._hosts = undefined;
    this._logs = new Map();
    this._samples = new Map();
    this._runs = [];
    this._updatesStatus = "";
    this._error = "";
    this._emitState();
  }

  private async _activateSignIn(): Promise<void> {
    this._setUpdatesStatus("");
    this._pollTimer ??= setInterval(
      () => void this._poll(),
      SESSION_POLL_INTERVAL_MS,
    );
    if (this._hosts !== undefined) {
      void this._poll();
      return;
    }
    this._loading = true;
    this._emitState();
    await Promise.all([this._poll(), this._refreshHosts()]);
    this._loading = false;
    this._emitState();
  }

  async resume(): Promise<void> {
    return this._auth.resume();
  }

  dispose(): void {
    this._actions.dispose();
    this._modals.dispose();
    this._stopPolling();
    super.dispose();
  }

  private async _refreshHosts(): Promise<void> {
    const epoch = this._signedInEpoch;
    try {
      const hosts = await this._api.listSshHosts();
      if (this._stale(epoch)) {
        return;
      }
      this._hosts = hosts;
      if (this._error === this._hostsError) {
        this._error = "";
      }
      this._hostsError = undefined;
      this._emitState();
      this._list.setCanCreate(
        hosts.length > 0,
        hosts.length ? "" : "Add an SSH host before creating a session.",
      );
    } catch (error) {
      if (this._stale(epoch)) {
        return;
      }
      if (this._hosts === undefined) {
        this._list.setCanCreate(
          false,
          "SSH hosts are temporarily unavailable.",
        );
      }
      this._hostsError = errorMessage(error);
      this._error = this._hostsError;
      this._emitState();
    }
  }

  get actions(): SessionActions {
    return this._actions;
  }

  get modals(): SessionModals {
    return this._modals;
  }

  async openCreate(): Promise<void> {
    return this._modals.openCreate(this._hosts ?? []);
  }

  async openSshHosts(): Promise<void> {
    await this._modals.openSshHosts();
    await this._refreshHosts();
  }
}

function unchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
