// The panel's session-lifecycle verbs: connect, run again, stop, delete, and
// Jupyter access once a session is READY. Stop and delete both cancel the
// session's Slurm job and confirm first; an SSH login challenge retries once.
import { Dialog, showDialog } from "@jupyterlab/apputils";
import { errorMessage, ISession, isTerminal } from "./Common";
import { ControlClient, ControlError, needsSshLogin } from "./ControlClient";
import type { SshLoginDock } from "./SshLoginDock";
import {
  cacheSessionAccess,
  clearSessionAccess,
  loadSessionAccess,
} from "./session-access";

interface ISessionActionsHooks {
  isDisposed: () => boolean;
  emitState: () => void;
  onError: (message: string) => void;
  sessions: () => readonly ISession[];
  replaceSessions: (sessions: ISession[]) => void;
  currentSessionId: () => string | undefined;
  select: (sessionId: string, current: () => boolean) => Promise<void>;
  loginDock: () => SshLoginDock;
  rejectDetail: () => void;
}

interface IJupyterOperation {
  sessionId: string;
  generation: string;
  selection: number;
}

export class SessionActions {
  private _selection = 0;
  private _busySessionIds = new Map<string, "relaunch" | "action">();
  private _busyTokens = new Map<string, number>();
  private _pendingDeletes = new Set<string>();
  private _connectingSessionId: string | undefined;
  private _jupyterReady = new Set<string>();
  private _jupyterOperations = new Map<string, IJupyterOperation>();
  private _lastAccessError: string | undefined;
  private _accessBackoffMs = new Map<string, number>();
  private _accessRetryAt = new Map<string, number>();
  private _accessBackoffGeneration = new Map<string, string>();

  constructor(
    private _api: ControlClient,
    private _hooks: ISessionActionsHooks,
  ) {}

  get busySessionIds(): ReadonlyMap<string, "relaunch" | "action"> {
    return this._busySessionIds;
  }

  get connectingSessionId(): string | undefined {
    return this._connectingSessionId;
  }

  get jupyterReady(): ReadonlySet<string> {
    return this._jupyterReady;
  }

  hasJupyterOperation(sessionId: string): boolean {
    return this._jupyterOperations.has(sessionId);
  }

  private _session(id: string): ISession | undefined {
    return this._hooks.sessions().find((session) => session.id === id);
  }

  private _selectedSession(id: string): ISession | undefined {
    const session = this._session(id);
    if (!session) {
      this._hooks.onError("Session is no longer available.");
      this._hooks.emitState();
    }
    return session;
  }

  releaseJupyter(id: string): void {
    this._abortJupyter(id);
    this._jupyterReady.delete(id);
  }

  releaseSession(id: string): void {
    this._cancelSelection(id);
    this.releaseJupyter(id);
    clearSessionAccess(id);
  }

  private _beginJupyter(session: ISession): IJupyterOperation {
    this._abortJupyter(session.id);
    const operation = {
      sessionId: session.id,
      generation: session.generation,
      selection: this._selection,
    };
    this._jupyterOperations.set(session.id, operation);
    return operation;
  }

  private _jupyterOperationCurrent(operation: IJupyterOperation): boolean {
    const session = this._session(operation.sessionId);
    return (
      !this._hooks.isDisposed() &&
      this._jupyterOperations.get(operation.sessionId) === operation &&
      operation.selection === this._selection &&
      session?.generation === operation.generation &&
      session.state === "READY"
    );
  }

  private _cancelSelection(sessionId: string): void {
    if (
      this._connectingSessionId === sessionId ||
      this._hooks.currentSessionId() === sessionId
    ) {
      this._selection++;
      this._connectingSessionId = undefined;
    }
  }

  private _abortJupyter(sessionId: string): void {
    if (this._jupyterOperations.delete(sessionId)) {
      this._busySessionIds.delete(sessionId);
    }
  }

  private abortJupyterOperations(): void {
    for (const sessionId of [...this._jupyterOperations.keys()]) {
      this._abortJupyter(sessionId);
    }
  }

  private _finishJupyter(operation: IJupyterOperation): boolean {
    if (this._jupyterOperations.get(operation.sessionId) !== operation) {
      return false;
    }
    this._jupyterOperations.delete(operation.sessionId);
    return true;
  }

  private async _overSsh<T>(
    alias: string,
    action: () => Promise<T>,
    allowLogin = true,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!allowLogin || !needsSshLogin(error)) {
        throw error;
      }
      const loginDock = this._hooks.loginDock();
      await loginDock.login(alias, this._api.sshAuthWebSocket(alias));
      return action();
    }
  }

  async refreshJupyter(sessionId: string): Promise<void> {
    const session = this._session(sessionId);
    if (!session || session.state !== "READY") {
      this._resetAccessBackoff(sessionId);
      return;
    }
    if (this._accessBackoffGeneration.get(sessionId) !== session.generation) {
      this._resetAccessBackoff(sessionId);
    }
    const retryAt = this._accessRetryAt.get(sessionId);
    if (retryAt !== undefined && Date.now() < retryAt) {
      return;
    }
    const operation = this._beginJupyter(session);
    try {
      await this._ensureAccess(session, operation);
      this._resetAccessBackoff(sessionId);
      const hadError = this._lastAccessError !== undefined;
      this._lastAccessError = undefined;
      if (this._jupyterOperationCurrent(operation) && hadError) {
        this._hooks.onError("");
        this._hooks.emitState();
      }
    } catch (error) {
      if (!this._jupyterOperationCurrent(operation)) return;
      const nextBackoff = Math.min(
        (this._accessBackoffMs.get(sessionId) ?? 500) * 2,
        30000,
      );
      this._accessBackoffMs.set(sessionId, nextBackoff);
      this._accessRetryAt.set(sessionId, Date.now() + nextBackoff);
      this._accessBackoffGeneration.set(sessionId, session.generation);
      const message = errorMessage(error);
      this._lastAccessError = message;
      this._hooks.onError(message);
      this._hooks.emitState();
    } finally {
      this._finishJupyter(operation);
    }
  }

  private _resetAccessBackoff(sessionId: string): void {
    this._accessBackoffMs.delete(sessionId);
    this._accessRetryAt.delete(sessionId);
    this._accessBackoffGeneration.delete(sessionId);
  }

  private async _ensureAccess(
    session: ISession,
    operation: IJupyterOperation,
  ): Promise<void> {
    if (!loadSessionAccess(session.id, session.generation)) {
      const access = await this._api.getSessionAccess(session.id);
      if (!this._jupyterOperationCurrent(operation)) return;
      if (access.generation !== operation.generation) {
        throw new Error("Session access generation changed.");
      }
      cacheSessionAccess(access);
    }
    if (!this._jupyterOperationCurrent(operation)) return;
    this._jupyterReady.add(session.id);
    this._hooks.emitState();
  }

  private async _ensureJupyter(session: ISession): Promise<void> {
    const operation = this._beginJupyter(session);
    const token = (this._busyTokens.get(session.id) ?? 0) + 1;
    this._busyTokens.set(session.id, token);
    this._busySessionIds.set(session.id, "action");
    this._hooks.emitState();
    try {
      await this._ensureAccess(session, operation);
    } catch (error) {
      if (this._jupyterOperations.get(session.id) === operation) {
        clearSessionAccess(session.id);
      }
      throw error;
    } finally {
      this._finishJupyter(operation);
      this._releaseBusy(session.id, token);
    }
  }

  async connect(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    const selection = ++this._selection;
    this.abortJupyterOperations();
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    this._hooks.onError("");
    this._connectingSessionId = session.id;
    this._hooks.emitState();
    try {
      await this._ensureJupyter(session);
      if (current()) await this._hooks.select(session.id, current);
    } catch (error) {
      if (current()) {
        this._hooks.onError(errorMessage(error));
        this._hooks.emitState();
      }
    } finally {
      if (current()) {
        this._connectingSessionId = undefined;
        this._hooks.emitState();
      }
    }
  }

  async runAgain(sessionId: string): Promise<void> {
    if (this._busySessionIds.has(sessionId)) {
      return;
    }
    await this._act(sessionId, (id) => this._api.startSession(id), {
      kind: "relaunch",
    });
  }

  async stop(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    this._hooks.rejectDetail();
    const confirmed = await showDialog({
      title: "Stop session",
      body: `Cancels the Slurm job on ${session.sshHost}. Anything unsaved in this session's kernels and terminals is lost.`,
      buttons: [
        Dialog.cancelButton({ label: "Cancel" }),
        Dialog.warnButton({ label: "Stop" }),
      ],
    });
    if (!confirmed.button.accept || this._hooks.isDisposed()) {
      return;
    }
    await this._act(sessionId, (id) => this._api.stopSession(id), {
      known: session,
    });
  }

  private async _act(
    sessionId: string,
    act: (id: string) => Promise<ISession>,
    options: {
      apply?: (acted: ISession) => ISession[];
      report?: (error: unknown) => boolean;
      allowLogin?: boolean;
      known?: ISession;
      clearError?: boolean;
      kind?: "relaunch" | "action";
    } = {},
  ): Promise<{ ok: boolean; error?: unknown }> {
    const {
      apply = (acted: ISession) =>
        this._hooks
          .sessions()
          .map((each) => (each.id === acted.id ? acted : each)),
      report = () => true,
      allowLogin = true,
      known,
      clearError = true,
      kind = "action",
    } = options;
    const session = known ?? this._selectedSession(sessionId);
    if (!session) {
      return { ok: false };
    }
    if (clearError) {
      this._hooks.onError("");
    }
    this.releaseSession(session.id);
    const selection = this._selection;
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    const token = (this._busyTokens.get(session.id) ?? 0) + 1;
    this._busyTokens.set(session.id, token);
    this._busySessionIds.set(session.id, kind);
    this._hooks.emitState();
    try {
      const acted = await this._overSsh(
        session.sshHost,
        () => act(session.id),
        allowLogin,
      );
      if (current()) {
        this._hooks.replaceSessions(apply(acted));
      }
      return { ok: true };
    } catch (error) {
      if (current()) {
        if (report(error)) {
          this._hooks.onError(errorMessage(error));
        } else if (clearError) {
          this._hooks.onError("");
        }
        this._hooks.emitState();
      }
      return { ok: false, error };
    } finally {
      this._releaseBusy(session.id, token);
    }
  }

  private _releaseBusy(sessionId: string, token: number): void {
    if (this._busyTokens.get(sessionId) !== token) {
      return;
    }
    this._busyTokens.delete(sessionId);
    this._busySessionIds.delete(sessionId);
    this._hooks.emitState();
  }

  async remove(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    const live = !isTerminal(session.state);
    this._hooks.rejectDetail();
    const confirmed = await showDialog({
      title: "Delete session",
      body: live
        ? `${session.rootFolder} on ${session.sshHost} is ${session.state.toLowerCase()}. Deleting it cancels the Slurm job and removes the card.`
        : `Remove ${session.rootFolder} on ${session.sshHost} from this list? It has already ended.`,
      buttons: [
        Dialog.cancelButton({ label: "Cancel" }),
        Dialog.warnButton({ label: "Delete" }),
      ],
    });
    if (!confirmed.button.accept || this._hooks.isDisposed()) {
      return;
    }
    if (
      (await this._delete(sessionId, true, session)) === "pending" &&
      this._hooks.sessions().some((each) => each.id === sessionId)
    ) {
      this._pendingDeletes.add(sessionId);
    }
  }

  async retryPendingDeletes(): Promise<void> {
    for (const sessionId of [...this._pendingDeletes]) {
      const session = this._hooks
        .sessions()
        .find((each) => each.id === sessionId);
      if (!session) {
        this._pendingDeletes.delete(sessionId);
        continue;
      }
      if (!isTerminal(session.state)) {
        continue;
      }
      if ((await this._delete(sessionId, false, session, true)) !== "pending") {
        this._pendingDeletes.delete(sessionId);
      }
    }
  }

  private async _delete(
    sessionId: string,
    allowLogin = true,
    known?: ISession,
    retry = false,
  ): Promise<"done" | "pending" | "failed"> {
    const retryable = (error: unknown): boolean =>
      (error instanceof ControlError && error.code === "session_not_stopped") ||
      (!allowLogin && needsSshLogin(error));
    const { ok, error } = await this._act(
      sessionId,
      (id) => this._api.deleteSession(id),
      {
        apply: () =>
          this._hooks.sessions().filter((each) => each.id !== sessionId),
        report: (error) => !retryable(error),
        allowLogin,
        known,
        clearError: !retry,
      },
    );
    if (ok) return "done";
    return retryable(error) ? "pending" : "failed";
  }

  dispose(): void {
    this._selection++;
    this.abortJupyterOperations();
    this._connectingSessionId = undefined;
    this._busySessionIds = new Map();
    this._busyTokens = new Map();
    this._pendingDeletes = new Set();
    this._jupyterReady = new Set();
    this._lastAccessError = undefined;
  }
}
