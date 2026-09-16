// A session's identity, on-screen state, and cached Jupyter access. Identity
// in the URL is the sessionId and seq pair, or nothing, and displayState is
// the one place that overlays a relaunching terminal session with SUBMITTING
// for display. Jupyter access is cached per seq in sessionStorage, so a
// restart's new seq cannot read a stale grant, and a valid Jupyter URI is a
// Dev Tunnel forwarding root only, with no path, port or query.
import type { IMetricSample, IRun, ISession, SessionState } from "./Common";
import {
  SESSION_ID,
  TOKEN_43,
  exactKeys,
  isPositiveInteger,
  isTerminal,
  parseUrl,
  validSessionId,
} from "./Common";
import type { ISessionLogTail } from "./ControlClient";

export function selectedSession(
  search = window.location.search,
): { sessionId: string; seq: number } | undefined {
  const query = new URLSearchParams(search);
  const sessionId = query.get("session")?.trim() ?? "";
  const seq = Number(query.get("seq"));
  return SESSION_ID.test(sessionId) && isPositiveInteger(seq)
    ? { sessionId, seq }
    : undefined;
}

export function sessionLiteUrl(
  sessionId: string,
  seq: number,
  documentPath?: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const id = validSessionId(sessionId);
  if (!isPositiveInteger(seq)) throw new Error("Invalid session seq.");
  const url = new URL(location.href);
  url.searchParams.set("session", id);
  url.searchParams.set("seq", String(seq));
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

export interface ISessionAccess {
  sessionId: string;
  seq: number;
  expiresAt: string;
  jupyter: { uri: string; token: string };
}

export function validDevTunnelRoot(value: string): URL {
  const invalid = "Jupyter URI is invalid.";
  const url = parseUrl(value, invalid);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+\.devtunnels\.ms$/i.test(url.hostname)
  ) {
    throw new Error(invalid);
  }
  return url;
}

export function validateSessionAccess(value: unknown): ISessionAccess {
  if (
    !exactKeys(value, ["expiresAt", "jupyter", "seq", "sessionId"]) ||
    !isPositiveInteger(value.seq) ||
    !(Date.parse(value.expiresAt) > Date.now()) ||
    !exactKeys(value.jupyter, ["token", "uri"]) ||
    !TOKEN_43.test(value.jupyter.token)
  ) {
    throw new Error("Session access is invalid or expired.");
  }
  validDevTunnelRoot(value.jupyter.uri);
  return {
    sessionId: value.sessionId,
    seq: value.seq,
    expiresAt: value.expiresAt,
    jupyter: { uri: value.jupyter.uri, token: value.jupyter.token },
  };
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
  seq: number,
): ISessionAccess | undefined {
  if (!isPositiveInteger(seq)) return undefined;
  const key = accessCacheKey(sessionId);
  const raw = sessionStorage.getItem(key);
  if (!raw) return undefined;
  try {
    const access = validateSessionAccess(JSON.parse(raw));
    if (access.sessionId !== sessionId || access.seq !== seq) {
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

function accessCacheKey(sessionId: string): string {
  return `${ACCESS_CACHE_PREFIX}${validSessionId(sessionId)}`;
}
