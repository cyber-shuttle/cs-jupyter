// The panel's session-lifecycle verbs: connect, run again, stop, delete, and
// Jupyter access once a session is READY. Stop and delete both cancel the
// session's Slurm job and confirm first; an SSH login challenge retries once.
import { Dialog, showDialog } from "@jupyterlab/apputils";
import { errorMessage, ISession, isTerminal } from "./Common";
import {
  accessUnavailable,
  ControlClient,
  ControlError,
  needsSshLogin,
} from "./ControlClient";
import type { SshLoginDock } from "./ssh";
import {
  cacheSessionAccess,
  clearSessionAccess,
  loadSessionAccess,
} from "./session";

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
  seq: number;
  selection: number;
}

interface IAccessBackoff {
  ms: number;
  retryAt: number;
  seq: number;
}

type BusyKind = "relaunch" | "action";

const deleteMissing = (error: unknown): boolean =>
  error instanceof ControlError &&
  (error.status === 404 || error.code === "session_not_found");

const transientDeleteFailure = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof ControlError &&
    (error.code === "session_not_stopped" ||
      error.status === 408 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500)));

async function confirm(
  title: string,
  body: string,
  label: string,
): Promise<boolean> {
  const result = await showDialog({
    title,
    body,
    buttons: [
      Dialog.cancelButton({ label: "Cancel" }),
      Dialog.warnButton({ label }),
    ],
  });
  return result.button.accept;
}

export class SessionActions {
  private _selection = 0;
  private _busySessionIds = new Map<string, BusyKind>();
  private _busyTokens = new Map<string, number>();
  private _pendingDeletes = new Set<string>();
  private _connectingSessionId: string | undefined;
  private _jupyterReady = new Set<string>();
  private _jupyterOperations = new Map<string, IJupyterOperation>();
  private _lastAccessError: string | undefined;
  private _accessBackoff = new Map<string, IAccessBackoff>();

  constructor(
    private _api: ControlClient,
    private _hooks: ISessionActionsHooks,
  ) {}

  get busySessionIds(): ReadonlyMap<string, BusyKind> {
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
    if (
      this._connectingSessionId === id ||
      this._hooks.currentSessionId() === id
    ) {
      this._selection++;
      this._connectingSessionId = undefined;
    }
    this.releaseJupyter(id);
    clearSessionAccess(id);
  }

  private _beginJupyter(session: ISession): IJupyterOperation {
    this._abortJupyter(session.id);
    const operation = {
      sessionId: session.id,
      seq: session.seq,
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
      session?.seq === operation.seq &&
      session.state === "READY"
    );
  }

  private _abortJupyter(sessionId: string): void {
    if (this._jupyterOperations.delete(sessionId)) {
      this._busySessionIds.delete(sessionId);
    }
  }

  private _abortAllJupyter(): void {
    for (const sessionId of [...this._jupyterOperations.keys()]) {
      this._abortJupyter(sessionId);
    }
  }

  private _finishJupyter(operation: IJupyterOperation): void {
    if (this._jupyterOperations.get(operation.sessionId) === operation) {
      this._jupyterOperations.delete(operation.sessionId);
    }
  }

  private _busy(sessionId: string, kind: BusyKind): () => void {
    const token = (this._busyTokens.get(sessionId) ?? 0) + 1;
    this._busyTokens.set(sessionId, token);
    this._busySessionIds.set(sessionId, kind);
    this._hooks.emitState();
    return () => {
      if (this._busyTokens.get(sessionId) !== token) return;
      this._busyTokens.delete(sessionId);
      this._busySessionIds.delete(sessionId);
      this._hooks.emitState();
    };
  }

  async refreshJupyter(sessionId: string): Promise<void> {
    const session = this._session(sessionId);
    if (!session || session.state !== "READY") {
      this._accessBackoff.delete(sessionId);
      return;
    }
    const backoff = this._accessBackoff.get(sessionId);
    if (backoff?.seq !== session.seq) {
      this._accessBackoff.delete(sessionId);
    } else if (Date.now() < backoff.retryAt) {
      return;
    }
    const operation = this._beginJupyter(session);
    try {
      await this._ensureAccess(session, operation);
      this._accessBackoff.delete(sessionId);
      const hadError = this._lastAccessError !== undefined;
      this._lastAccessError = undefined;
      if (this._jupyterOperationCurrent(operation) && hadError) {
        this._hooks.onError("");
        this._hooks.emitState();
      }
    } catch (error) {
      if (!this._jupyterOperationCurrent(operation)) return;
      const ms = Math.min(
        (this._accessBackoff.get(sessionId)?.ms ?? 500) * 2,
        30000,
      );
      this._accessBackoff.set(sessionId, {
        ms,
        retryAt: Date.now() + ms,
        seq: session.seq,
      });
      const message = accessUnavailable(error) ? "" : errorMessage(error);
      this._lastAccessError = message || undefined;
      this._hooks.onError(message);
      this._hooks.emitState();
    } finally {
      this._finishJupyter(operation);
    }
  }

  private async _ensureAccess(
    session: ISession,
    operation: IJupyterOperation,
  ): Promise<void> {
    if (!loadSessionAccess(session.id, session.seq)) {
      const access = await this._api.getSessionAccess(session.id);
      if (!this._jupyterOperationCurrent(operation)) return;
      if (access.seq !== operation.seq) {
        throw new Error("Session access seq changed.");
      }
      cacheSessionAccess(access);
    }
    if (!this._jupyterOperationCurrent(operation)) return;
    this._jupyterReady.add(session.id);
    this._hooks.emitState();
  }

  async connect(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    const selection = ++this._selection;
    this._abortAllJupyter();
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    this._hooks.onError("");
    this._connectingSessionId = session.id;
    this._hooks.emitState();
    const operation = this._beginJupyter(session);
    const release = this._busy(session.id, "action");
    try {
      try {
        await this._ensureAccess(session, operation);
      } catch (error) {
        if (this._jupyterOperations.get(session.id) === operation) {
          clearSessionAccess(session.id);
        }
        throw error;
      } finally {
        this._finishJupyter(operation);
        release();
      }
      if (current()) await this._hooks.select(session.id, current);
    } catch (error) {
      if (current()) {
        this._hooks.onError(
          accessUnavailable(error) ? "" : errorMessage(error),
        );
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
    const session = this._selectedSession(sessionId);
    if (session) {
      await this._act(session, (id) => this._api.startSession(id), {
        kind: "relaunch",
      });
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    this._hooks.rejectDetail();
    const confirmed = await confirm(
      "Stop session",
      `Cancels the Slurm job on ${session.sshHost}. Anything unsaved in this session's kernels and terminals is lost.`,
      "Stop",
    );
    if (!confirmed || this._hooks.isDisposed()) {
      return;
    }
    await this._act(session, (id) => this._api.stopSession(id));
  }

  private async _act(
    session: ISession,
    act: (id: string) => Promise<ISession>,
    options: {
      apply?: (acted: ISession) => ISession[];
      report?: (error: unknown) => boolean;
      allowLogin?: boolean;
      clearError?: boolean;
      kind?: BusyKind;
    } = {},
  ): Promise<{ ok: boolean; error?: unknown }> {
    const {
      apply = (acted: ISession) =>
        this._hooks
          .sessions()
          .map((each) => (each.id === acted.id ? acted : each)),
      report = () => true,
      allowLogin = true,
      clearError = true,
      kind = "action",
    } = options;
    if (clearError) {
      this._hooks.onError("");
    }
    this.releaseSession(session.id);
    const selection = this._selection;
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    const release = this._busy(session.id, kind);
    try {
      const acted = await act(session.id).catch(async (error) => {
        if (!allowLogin || !needsSshLogin(error)) throw error;
        await this._hooks
          .loginDock()
          .login(session.sshHost, this._api.sshAuthWebSocket(session.sshHost));
        return act(session.id);
      });
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
      release();
    }
  }

  async remove(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    const live = !isTerminal(session.state);
    this._hooks.rejectDetail();
    const confirmed = await confirm(
      live ? "Stop and delete session" : "Delete session",
      live
        ? `${session.rootFolder} on ${session.sshHost} is ${session.state.toLowerCase()}. Its Slurm job will be stopped now and the session removed after it ends.`
        : `Remove ${session.rootFolder} on ${session.sshHost} from this list? It has already ended.`,
      live ? "Stop and delete" : "Delete",
    );
    if (!confirmed || this._hooks.isDisposed()) {
      return;
    }
    if (live) {
      const { ok } = await this._act(session, (id) =>
        this._api.stopSession(id),
      );
      if (ok && this._hooks.sessions().some((each) => each.id === sessionId)) {
        this._pendingDeletes.add(sessionId);
      }
      return;
    }
    await this._deleteTerminal(session, false);
  }

  async retryPendingDeletes(): Promise<void> {
    for (const sessionId of [...this._pendingDeletes]) {
      const session = this._session(sessionId);
      if (!session) {
        this._pendingDeletes.delete(sessionId);
      } else if (isTerminal(session.state)) {
        await this._deleteTerminal(session, true);
      }
    }
  }

  private async _deleteTerminal(
    session: ISession,
    retry: boolean,
  ): Promise<void> {
    if (this._busySessionIds.has(session.id)) {
      return;
    }
    const { ok, error } = await this._act(
      session,
      async (id) => {
        await this._api.deleteSession(id).catch((error) => {
          if (!deleteMissing(error)) {
            throw error;
          }
        });
        return session;
      },
      {
        clearError: !retry,
        allowLogin: false,
        apply: () =>
          this._hooks.sessions().filter((each) => each.id !== session.id),
        report: (error) => !transientDeleteFailure(error),
      },
    );
    if (!ok && transientDeleteFailure(error)) {
      this._pendingDeletes.add(session.id);
    } else {
      this._pendingDeletes.delete(session.id);
    }
  }

  dispose(): void {
    this._selection++;
    this._abortAllJupyter();
    this._connectingSessionId = undefined;
    this._busySessionIds = new Map();
    this._busyTokens = new Map();
    this._pendingDeletes = new Set();
    this._jupyterReady = new Set();
    this._lastAccessError = undefined;
  }
}
