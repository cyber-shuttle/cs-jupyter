// The panel's session-lifecycle verbs: create, connect, start, stop, delete, and
// Jupyter readiness once a session's job runs. Readiness means the CyberShuttle
// API granted access; this page's own session starts ready, and the page a
// connect opens fetches access again. Stop and delete confirm first.
import { Dialog, showDialog } from "@jupyterlab/apputils";
import {
  clusterLabel,
  errorMessage,
  ISession,
  isRunning,
  type Schemas,
} from "./Common";
import { accessUnavailable, PlaneClient } from "./PlaneClient";
import type { SessionController } from "./SessionController";
import { getActiveSessionId } from "./session";

interface ISessionActionsHooks {
  isDisposed: () => boolean;
  emitState: () => void;
  onError: (message: string) => void;
  sessions: () => readonly ISession[];
  clusters: () => readonly Schemas["SlurmClusterConfigResponse"][];
  replaceSessions: (sessions: ISession[]) => void;
  rejectDetail: () => void;
}

interface IJupyterOperation {
  sessionId: string;
  selection: number;
}

interface IAccessBackoff {
  ms: number;
  retryAt: number;
}

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
  private _busySessionIds = new Set<string>();
  private _busyTokens = new Map<string, number>();
  private _connectingSessionId: string | undefined;
  private _jupyterReady = new Set<string>();
  private _jupyterOperations = new Map<string, IJupyterOperation>();
  private _lastAccessError: string | undefined;
  private _accessBackoff = new Map<string, IAccessBackoff>();

  constructor(
    private _api: PlaneClient,
    private _controller: SessionController,
    private _hooks: ISessionActionsHooks,
  ) {
    const active = getActiveSessionId();
    if (active) this._jupyterReady.add(active);
  }

  get busySessionIds(): ReadonlySet<string> {
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
    return this._hooks.sessions().find((session) => session.sessionId === id);
  }

  private _selectedSession(id: string): ISession | undefined {
    const session = this._session(id);
    if (!session) {
      this._hooks.onError("Session is no longer available.");
      this._hooks.emitState();
    }
    return session;
  }

  private _label(session: ISession): string {
    return clusterLabel(this._hooks.clusters(), session.slurmClusterConfigId);
  }

  releaseJupyter(id: string): void {
    this._abortJupyter(id);
    this._jupyterReady.delete(id);
  }

  releaseSession(id: string): void {
    if (this._connectingSessionId === id || getActiveSessionId() === id) {
      this._selection++;
      this._connectingSessionId = undefined;
    }
    this.releaseJupyter(id);
  }

  private _beginJupyter(session: ISession): IJupyterOperation {
    this._abortJupyter(session.sessionId);
    const operation = {
      sessionId: session.sessionId,
      selection: this._selection,
    };
    this._jupyterOperations.set(session.sessionId, operation);
    return operation;
  }

  private _jupyterOperationCurrent(operation: IJupyterOperation): boolean {
    const session = this._session(operation.sessionId);
    return (
      !this._hooks.isDisposed() &&
      this._jupyterOperations.get(operation.sessionId) === operation &&
      operation.selection === this._selection &&
      session !== undefined &&
      isRunning(session.state)
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

  private _busy(sessionId: string): () => void {
    const token = (this._busyTokens.get(sessionId) ?? 0) + 1;
    this._busyTokens.set(sessionId, token);
    this._busySessionIds.add(sessionId);
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
    if (!session || !isRunning(session.state)) {
      this._accessBackoff.delete(sessionId);
      return;
    }
    if (Date.now() < (this._accessBackoff.get(sessionId)?.retryAt ?? 0)) {
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
      this._accessBackoff.set(sessionId, { ms, retryAt: Date.now() + ms });
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
    if (!this._jupyterReady.has(session.sessionId)) {
      await this._api.getSessionAccess(session.runs[0].processId);
    }
    if (!this._jupyterOperationCurrent(operation)) return;
    this._jupyterReady.add(session.sessionId);
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
    this._connectingSessionId = session.sessionId;
    this._hooks.emitState();
    const operation = this._beginJupyter(session);
    const release = this._busy(session.sessionId);
    try {
      try {
        await this._ensureAccess(session, operation);
      } finally {
        this._finishJupyter(operation);
        release();
      }
      if (current()) {
        if (!this._jupyterReady.has(session.sessionId)) {
          throw new Error("Session must be READY.");
        }
        await this._controller.select(session, current);
      }
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

  async start(sessionId: string): Promise<void> {
    if (this._busySessionIds.has(sessionId)) {
      return;
    }
    const session = this._selectedSession(sessionId);
    if (session) {
      await this._act(session, (each) =>
        this._api.startSession(each.sessionId),
      );
    }
  }

  async create(request: Schemas["SessionRequest"]): Promise<ISession> {
    this._hooks.onError("");
    const session = await this._api.createSession(request);
    this._hooks.replaceSessions([
      session,
      ...this._hooks
        .sessions()
        .filter((each) => each.sessionId !== session.sessionId),
    ]);
    this._hooks.emitState();
    return session;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    this._hooks.rejectDetail();
    const confirmed = await confirm(
      "Stop session",
      `Cancels the Slurm job on ${this._label(session)}. Anything unsaved in this session's kernels and terminals is lost.`,
      "Stop",
    );
    if (!confirmed || this._hooks.isDisposed()) {
      return;
    }
    await this._act(session, (each) => this._api.stopSession(each));
  }

  async remove(sessionId: string): Promise<void> {
    const session = this._selectedSession(sessionId);
    if (!session) {
      return;
    }
    const confirmed = await confirm(
      "Delete session",
      "Removes this session and its runs from Run History.",
      "Delete",
    );
    if (!confirmed || this._hooks.isDisposed()) {
      return;
    }
    await this._act(
      session,
      (each) => this._api.deleteSession(each.sessionId),
      () =>
        this._hooks.sessions().filter((each) => each.sessionId !== sessionId),
    );
  }

  private async _act<T>(
    session: ISession,
    act: (session: ISession) => Promise<T>,
    apply = (acted: T): ISession[] =>
      this._hooks
        .sessions()
        .map((each) =>
          each.sessionId === session.sessionId ? (acted as ISession) : each,
        ),
  ): Promise<void> {
    this._hooks.onError("");
    this.releaseSession(session.sessionId);
    const selection = this._selection;
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    const release = this._busy(session.sessionId);
    try {
      const acted = await act(session);
      if (current()) {
        this._hooks.replaceSessions(apply(acted));
      }
    } catch (error) {
      if (current()) {
        this._hooks.onError(errorMessage(error));
        this._hooks.emitState();
      }
    } finally {
      release();
    }
  }

  dispose(): void {
    this._selection++;
    this._abortAllJupyter();
    this._connectingSessionId = undefined;
    this._busySessionIds = new Set();
    this._busyTokens = new Map();
    this._jupyterReady = new Set();
    this._lastAccessError = undefined;
  }
}
