// The stateful controller behind the launcher panel: it polls cs-control and
// holds session, run and log state. It composes auth, actions and modals rather
// than owning their logic itself. Log tails are replaced wholly each poll rather
// than merged.
import { Signal } from "@lumino/signaling";
import { StackedPanel } from "@lumino/widgets";
import {
  errorMessage,
  IMetricSample,
  IRun,
  ISession,
  ISshHost,
  isTerminal,
} from "./Common";
import { ControlClient, ISessionLogTail, UNCHANGED } from "./ControlClient";
import { SessionController } from "./SessionController";
import { clearSessionAccess } from "./session-access";
import { SessionActions } from "./session-actions";
import { getActiveSessionId } from "./session-state";
import type { ISessionUiState } from "./session-ui-state";
import { CyberShuttleHeader } from "./CyberShuttleHeader";
import { SessionList } from "./SessionList";
import { SignInController } from "./SignInController";
import { SessionModals } from "./modals";
import { AuthInteractionRequiredError } from "./AuthClient";

const SESSION_POLL_INTERVAL_MS = 1000;

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
    this.header.signInRequested.connect(() => void this.signIn());
    this.header.signOutRequested.connect(() => this.signOut());
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
      if (!session || session.generation !== previous.generation) {
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

  signIn(): Promise<void> {
    return this._auth.signIn();
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
