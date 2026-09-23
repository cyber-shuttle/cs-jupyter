// A session's identity, on-screen state, and cached Jupyter access. Identity
// in the URL is the sessionId or nothing; the attempt seq stays server-side
// and arrives with the session record. displayState is the one place that
// overlays a relaunching terminal session with SUBMITTING for display. Cached
// Jupyter access carries the seq it was granted for, so a caller that knows
// the live seq can refuse a stale grant, and its Jupyter URI is that
// session's cs-plane proxy path.
import type { IMetricSample, IRun, ISession, SessionState } from "./Common";
import {
  SESSION_ID,
  TOKEN_43,
  isTerminal,
  vObject,
  vPositiveInt,
  vString,
  validSessionId,
} from "./Common";
import type { ISessionLogTail } from "./ControlClient";

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

let activeSession: string | undefined;

export function setActiveSessionId(id: string | undefined): void {
  activeSession = id;
}

export function getActiveSessionId(): string | undefined {
  return activeSession;
}

type IBusySessionIds = ReadonlyMap<string, "relaunch" | "action">;

export interface ISessionUiState {
  readonly sessions: readonly ISession[];
  readonly logs: ReadonlyMap<string, ISessionLogTail>;
  readonly samples: ReadonlyMap<string, readonly IMetricSample[]>;
  readonly runs: readonly IRun[];
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly busySessionIds: IBusySessionIds;
  readonly connectingSessionId: string | undefined;
  readonly jupyterReady: ReadonlySet<string>;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly account: string | undefined;
}

export const emptyState = (): ISessionUiState => ({
  sessions: [],
  logs: new Map(),
  samples: new Map(),
  runs: [],
  loading: false,
  updatesStatus: "",
  error: "",
  busySessionIds: new Map(),
  connectingSessionId: undefined,
  jupyterReady: new Set(),
  signedIn: false,
  signingIn: false,
  account: undefined,
});

export function displayState(
  session: ISession,
  busy: IBusySessionIds,
): SessionState {
  return busy.get(session.id) === "relaunch" && isTerminal(session.state)
    ? "SUBMITTING"
    : session.state;
}

const ACCESS_CACHE_PREFIX = "cybershuttle.session-access.v1.";
export const RUN_REPORT_KEY = "cybershuttle.run-report.v1";

export interface ISessionAccess {
  sessionId: string;
  seq: number;
  expiresAt: string;
  jupyter: { uri: string; token: string };
}

const accessShape = vObject<ISessionAccess>({
  sessionId: vString(SESSION_ID),
  seq: vPositiveInt,
  expiresAt: vString(),
  jupyter: vObject({ uri: vString(), token: vString(TOKEN_43) }),
});

export function validateSessionAccess(value: unknown): ISessionAccess {
  if (!accessShape(value) || !(Date.parse(value.expiresAt) > Date.now())) {
    throw new Error("Session access is invalid or expired.");
  }
  return value;
}

export function cacheSessionAccess(access: ISessionAccess): void {
  const valid = validateSessionAccess(access);
  sessionStorage.setItem(
    accessCacheKey(valid.sessionId),
    JSON.stringify(valid),
  );
}

export function loadSessionAccess(
  sessionId: string,
  seq?: number,
): ISessionAccess | undefined {
  const key = accessCacheKey(sessionId);
  const raw = sessionStorage.getItem(key);
  if (!raw) return undefined;
  try {
    const access = validateSessionAccess(JSON.parse(raw));
    if (
      access.sessionId !== sessionId ||
      (seq !== undefined && access.seq !== seq)
    ) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    return access;
  } catch {
    sessionStorage.removeItem(key);
    return undefined;
  }
}

export function clearSessionAccess(sessionId: string): void {
  sessionStorage.removeItem(accessCacheKey(sessionId));
}

export function clearAllSessionAccess(): void {
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(ACCESS_CACHE_PREFIX)) sessionStorage.removeItem(key);
  }
}

function accessCacheKey(sessionId: string): string {
  return `${ACCESS_CACHE_PREFIX}${validSessionId(sessionId)}`;
}
