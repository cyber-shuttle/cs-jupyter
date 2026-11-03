// The panel's session-lifecycle verbs: create, connect, start, stop, and
// Jupyter readiness once a session's job runs. Readiness means the CyberShuttle
// API granted access; this page's own session starts ready, and the page a
// connect opens fetches access again. Stop confirms first.
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

type BusyKind = "start" | "action";

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

  private _label(session: ISession): string {
    return clusterLabel(this._hooks.clusters(), session.configId);
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
    this._abortJupyter(session.id);
    const operation = { sessionId: session.id, selection: this._selection };
    this._jupyterOperations.set(session.id, operation);
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
    if (!this._jupyterReady.has(session.id)) {
      await this._api.getSessionAccess(session.id);
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
      } finally {
        this._finishJupyter(operation);
        release();
      }
      if (current()) {
        if (!this._jupyterReady.has(session.id)) {
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
      await this._act(session, (id) => this._api.startSession(id), {
        kind: "start",
      });
    }
  }

  async create(request: Schemas["BatchProcessRequest"]): Promise<ISession> {
    const session = await this._api.createSession(request);
    const { ok, error } = await this._act(
      session,
      (id) => this._api.startSession(id),
      {
        kind: "start",
        report: () => false,
        apply: (acted) => [
          ...this._hooks.sessions().filter((each) => each.id !== acted.id),
          acted,
        ],
      },
    );
    if (!ok) throw error;
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
    await this._act(session, (id) => this._api.stopSession(id));
  }

  private async _act(
    session: ISession,
    act: (id: string) => Promise<ISession>,
    options: {
      apply?: (acted: ISession) => ISession[];
      report?: (error: unknown) => boolean;
      kind?: BusyKind;
    } = {},
  ): Promise<{ ok: boolean; error?: unknown }> {
    const {
      apply = (acted: ISession) =>
        this._hooks
          .sessions()
          .map((each) => (each.id === acted.id ? acted : each)),
      report = () => true,
      kind = "action",
    } = options;
    this._hooks.onError("");
    this.releaseSession(session.id);
    const selection = this._selection;
    const current = (): boolean =>
      selection === this._selection && !this._hooks.isDisposed();
    const release = this._busy(session.id, kind);
    try {
      const acted = await act(session.id);
      if (current()) {
        this._hooks.replaceSessions(apply(acted));
      }
      return { ok: true };
    } catch (error) {
      if (current()) {
        if (report(error)) {
          this._hooks.onError(errorMessage(error));
        }
        this._hooks.emitState();
      }
      return { ok: false, error };
    } finally {
      release();
    }
  }

  dispose(): void {
    this._selection++;
    this._abortAllJupyter();
    this._connectingSessionId = undefined;
    this._busySessionIds = new Map();
    this._busyTokens = new Map();
    this._jupyterReady = new Set();
    this._lastAccessError = undefined;
  }
}
