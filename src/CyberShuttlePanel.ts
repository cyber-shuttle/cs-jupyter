// The stateful panel mounted in JupyterLab's Launcher: polls cs-plane, holds
// session/run/log state and the sign-in state machine, and renders the title
// row's sign-in status. It composes actions and modals rather than owning
// their logic, and replaces log tails wholly each poll rather than merging.
import { Signal } from "@lumino/signaling";
import { StackedPanel } from "@lumino/widgets";
import {
  errorMessage,
  IUsageSample,
  IRun,
  ISession,
  ISshHost,
  isTerminal,
} from "./Common";
import { AuthInteractionRequiredError } from "./AuthClient";
import { PlaneClient, ISessionLogTail, UNCHANGED } from "./PlaneClient";
import { PanelBoundWidget } from "./RebuildingWidget";
import { SessionController } from "./SessionController";
import {
  getActiveSession,
  getActiveSessionId,
  RUN_REPORT_KEY,
  sessionHomeUrl,
  type ISessionUiState,
} from "./session";
import { SessionActions } from "./session-actions";
import { SessionList } from "./SessionList";
import { SessionModals } from "./modals";
import { accountingState } from "./usage";
import { button, countsDown, element, remainingMs } from "./dom";

const SESSION_POLL_INTERVAL_MS = 1000;

export class CyberShuttleHeader extends PanelBoundWidget {
  readonly signInRequested = new Signal<this, void>(this);
  readonly signOutRequested = new Signal<this, void>(this);
  readonly sshKeysRequested = new Signal<this, void>(this);
  readonly devTunnelsAccountRequested = new Signal<this, void>(this);

  private _accountMenuOpen = false;

  constructor(panel: CyberShuttlePanel) {
    super(panel);
    this.addClass("csSessionHeaderWidget");
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
    const { signedIn, signingIn, identity } = this._state;
    const trigger = button(
      "",
      `csTextButton csIdentityButton ${signedIn ? "csAccountButton" : "csSignInButton"}`,
    );
    trigger.innerHTML = USER_GLYPH;
    trigger.appendChild(
      element(
        "span",
        signedIn
          ? (identity ?? "Account")
          : signingIn
            ? "Signing in…"
            : "Sign in",
      ),
    );
    trigger.dataset.sessionAction = signedIn ? "account" : "sign-in";
    trigger.disabled = signingIn;
    if (signedIn) {
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", String(this._accountMenuOpen));
      trigger.onclick = () => {
        this._accountMenuOpen = !this._accountMenuOpen;
        this._render();
      };
    } else {
      trigger.onclick = () => this.signInRequested.emit(undefined);
    }
    holder.appendChild(trigger);
    if (signedIn && this._accountMenuOpen) {
      const menu = element("div", "", "csAccountMenu", { role: "menu" });
      menu.append(
        this._menuItem(
          "Dev Tunnels",
          "devtunnels-account",
          DEVTUNNELS_GLYPH,
          () => this.devTunnelsAccountRequested.emit(undefined),
        ),
        this._menuItem("SSH Keys", "ssh-keys", KEY_GLYPH, () =>
          this.sshKeysRequested.emit(undefined),
        ),
        this._menuItem("Sign out", "sign-out", SIGN_OUT_GLYPH, () =>
          this.signOutRequested.emit(undefined),
        ),
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
    const item = button("", "csAccountMenuItem", () => {
      this._accountMenuOpen = false;
      choose();
    });
    item.innerHTML = glyph;
    item.appendChild(element("span", label));
    item.dataset.sessionAction = action;
    item.setAttribute("role", "menuitem");
    return item;
  }
}

const KEY_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="10" r="3.6" /><path d="M10.6 10h7.2M15.2 10v2.6M17.8 10v2" /></g></svg>`;
const DEVTUNNELS_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M7 13 13 7" /><path d="M8.5 4.5h3A3.5 3.5 0 0 1 15 8v0" /><path d="M11.5 15.5h-3A3.5 3.5 0 0 1 5 12v0" /></g></svg>`;
const SIGN_OUT_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5H4.5v13H8M12.5 6.5 16 10l-3.5 3.5M16 10H7.5" /></g></svg>`;

const USER_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="10" cy="10" r="8.6" /><circle cx="10" cy="8.2" r="2.6" /><path d="M5.3 16.5a5 5 0 0 1 9.4 0" /></g></svg>`;

export class CyberShuttlePanel extends StackedPanel {
  readonly stateChanged = new Signal<this, ISessionUiState>(this);
  readonly restored: Promise<void>;

  readonly header: CyberShuttleHeader;
  private _pollTimer: number | undefined;
  private _polling = false;
  private _sessions: ISession[] = [];
  private _logs = new Map<string, ISessionLogTail>();
  private _samples = new Map<string, IUsageSample[]>();
  private _runs: IRun[] = [];
  private _loading = false;
  private _updatesStatus = "";
  private _error = "";
  private _hosts: ISshHost[] | undefined;
  private _signedInEpoch = 0;
  private _hostsError: string | undefined;
  private _signedIn = false;
  private _signInPromise: Promise<void> | undefined;
  private _modals: SessionModals;
  private _actions: SessionActions;

  constructor(
    private _api: PlaneClient,
    controller: SessionController,
  ) {
    super();
    this.id = "cybershuttle-session-panel";
    this.addClass("csShell");
    this._actions = new SessionActions(_api, controller, {
      isDisposed: () => this.isDisposed,
      emitState: () => this._emitState(),
      onError: (message) => (this._error = message),
      sessions: () => this._sessions,
      replaceSessions: (sessions) => (this._sessions = sessions),
      sshAuthDock: () => this._modals.sshAuthDock,
      rejectDetail: () => this._modals.rejectDetail(),
    });
    this._modals = new SessionModals(this, _api);
    this.header = new CyberShuttleHeader(this);
    const list = new SessionList(this);
    this.addWidget(list);
    list.sessionRequested.connect(
      (_sender, id) => void this._modals.openSession(id),
    );
    list.createRequested.connect(() => void this.openCreate());
    list.sshHostsRequested.connect(() => void this.openSshHosts());
    list.runHistoryRequested.connect(() => void this._modals.openRunHistory());
    this.header.signInRequested.connect(() => void this.signIn());
    this.header.signOutRequested.connect(() => this.signOut());
    this.header.sshKeysRequested.connect(() => void this._modals.openSshKeys());
    this.header.devTunnelsAccountRequested.connect(
      () => void this._modals.openDevTunnelsAccount(),
    );
    this._emitState();
    this.restored = this._resume();
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
      createBlocked: this._hosts?.length
        ? ""
        : this._hosts === undefined && this._hostsError !== undefined
          ? "SSH hosts are temporarily unavailable."
          : "Add an SSH host before creating a session.",
      busySessionIds: this._actions.busySessionIds,
      connectingSessionId: this._actions.connectingSessionId,
      jupyterReady: new Set(this._actions.jupyterReady),
      signedIn: this._signedIn,
      signingIn: this._signInPromise !== undefined,
      identity: this._signedIn ? this._api.identity : undefined,
    };
  }

  private _emitState(): void {
    this.stateChanged.emit(this.state);
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
    const active = getActiveSession();
    const live = active && next.get(active.id);
    if (live?.state === "READY" && live.seq !== active!.seq) {
      window.location.reload();
    }
    this._sessions = sessions;
    this._emitState();
  }

  // Every tick, since walltime runs out without the list changing.
  private _leaveIfEnded(): boolean {
    const active = getActiveSession();
    const live =
      active && this._sessions.find((session) => session.id === active.id);
    if (
      !live ||
      !(isTerminal(live.state) || remainingMs(live, Date.now()) === 0)
    ) {
      return false;
    }
    sessionStorage.setItem(RUN_REPORT_KEY, `${live.id}/${live.seq}`);
    window.location.replace(sessionHomeUrl());
    return true;
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
    window.clearInterval(this._pollTimer);
    this._pollTimer = undefined;
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
      if (this._leaveIfEnded()) return;
      await Promise.all([
        this._pollSamples(epoch),
        this._pollRuns(epoch, list !== UNCHANGED),
      ]);
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
        this._requireAuthentication();
        return;
      }
      this._setUpdatesStatus("Session updates unavailable.");
    } finally {
      this._polling = false;
    }
  }

  private async _pollRuns(epoch: number, listChanged: boolean): Promise<void> {
    const now = Date.now();
    if (
      !listChanged &&
      !this._modals.runHistoryOpen &&
      !this._runs.some((run) => accountingState(run, now) === "pending")
    ) {
      return;
    }
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
    const live = this._sessions.filter(countsDown);
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
      const series = await this._api.getSessionUsage(sessionId);
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

  signIn(): Promise<void> {
    if (!this._signInPromise) {
      this._error = "";
      this._signInPromise = this._api
        .signIn()
        .catch((error) => {
          this._error = errorMessage(error);
        })
        .finally(() => {
          this._signInPromise = undefined;
          if (!this.isDisposed) this._emitState();
        });
      this._emitState();
    }
    return this._signInPromise;
  }

  private _requireAuthentication(): void {
    this._signedIn = false;
    this._stopPolling();
    this._setUpdatesStatus("Sign in again to resume session updates.");
  }

  signOut(): void {
    this._signedInEpoch++;
    this._api.signOut();
    this._stopPolling();
    this._signedIn = false;
    this._actions.dispose();
    this._sessions = [];
    this._hosts = undefined;
    this._logs = new Map();
    this._samples = new Map();
    this._runs = [];
    this._updatesStatus = "";
    this._error = "";
    this._emitState();
    if (getActiveSessionId()) window.location.replace(sessionHomeUrl());
  }

  private async _resume(): Promise<void> {
    try {
      await this._api.resumeSignIn();
    } catch (error) {
      if (!(error instanceof AuthInteractionRequiredError)) {
        this._error = errorMessage(error);
        this._emitState();
      }
      return;
    }
    if (this.isDisposed) return;
    this._signedIn = true;
    this._pollTimer = window.setInterval(
      () => void this._poll(),
      SESSION_POLL_INTERVAL_MS,
    );
    this._loading = true;
    this._emitState();
    await Promise.all([this._poll(), this._refreshHosts()]);
    const run = sessionStorage.getItem(RUN_REPORT_KEY);
    sessionStorage.removeItem(RUN_REPORT_KEY);
    if (run && this._signedIn) void this._modals.openRunHistory(run);
    this._loading = false;
    this._emitState();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
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
    } catch (error) {
      if (this._stale(epoch)) {
        return;
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
