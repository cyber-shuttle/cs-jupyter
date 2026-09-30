// A session's URL and on-screen state. The URL carries the sessionId or
// nothing; the run number stays in cs-plane and arrives with the session
// record. The active session is the one this page attached to, with the run
// its Jupyter access was granted for. displayState is the one place that
// overlays a terminal session being started with SUBMITTING for display.
import type { IUsageSample, IRun, ISession, SessionState } from "./Common";
import { SESSION_ID, isTerminal, validSessionId } from "./Common";
import type { ISessionLogTail } from "./PlaneClient";

export function selectedSession(
  search = window.location.search,
): { sessionId: string } | undefined {
  const query = new URLSearchParams(search);
  const sessionId = query.get("session") ?? "";
  const workspace = query.get("workspace") ?? "";
  return SESSION_ID.test(sessionId) && workspace === sessionId
    ? { sessionId }
    : undefined;
}

export function sessionHomeUrl(): string {
  const url = new URL("index.html", window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function sessionLiteUrl(
  sessionId: string,
  documentPath?: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const id = validSessionId(sessionId);
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("session", id);
  url.searchParams.set("workspace", id);
  documentPath
    ? url.searchParams.set("path", documentPath)
    : url.searchParams.delete("path");
  return url.toString();
}

type IActiveSession = Pick<ISession, "id" | "seq">;

let activeSession: IActiveSession | undefined;

export function setActiveSession(session: IActiveSession | undefined): void {
  activeSession = session;
}

export function getActiveSession(): IActiveSession | undefined {
  return activeSession;
}

export function getActiveSessionId(): string | undefined {
  return activeSession?.id;
}

type IBusySessionIds = ReadonlyMap<string, "start" | "action">;

export interface ISessionUiState {
  readonly sessions: readonly ISession[];
  readonly logs: ReadonlyMap<string, ISessionLogTail>;
  readonly samples: ReadonlyMap<string, readonly IUsageSample[]>;
  readonly runs: readonly IRun[];
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly createBlocked: string;
  readonly busySessionIds: IBusySessionIds;
  readonly connectingSessionId: string | undefined;
  readonly jupyterReady: ReadonlySet<string>;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly identity: string | undefined;
}

export const emptyState = (): ISessionUiState => ({
  sessions: [],
  logs: new Map(),
  samples: new Map(),
  runs: [],
  loading: false,
  updatesStatus: "",
  error: "",
  createBlocked: "",
  busySessionIds: new Map(),
  connectingSessionId: undefined,
  jupyterReady: new Set(),
  signedIn: false,
  signingIn: false,
  identity: undefined,
});

export function displayState(
  session: ISession,
  busy: IBusySessionIds,
): SessionState {
  return busy.get(session.id) === "start" && isTerminal(session.state)
    ? "SUBMITTING"
    : session.state;
}

export const RUN_REPORT_KEY = "cybershuttle.run-report.v1";
