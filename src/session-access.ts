// Caches a session's Jupyter access per generation in sessionStorage. A restart
// of the same session starts a new generation, so it cannot read a stale grant.
// A valid Jupyter URI is a Dev Tunnel forwarding root only, with no path, port
// or query.
import {
  GENERATION,
  TOKEN_43,
  exactKeys,
  parseUrl,
  validSessionId,
} from "./Common";

const CACHE_PREFIX = "cybershuttle.session-access.v1.";

export interface ISessionAccess {
  sessionId: string;
  generation: string;
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
    !exactKeys(value, ["expiresAt", "generation", "jupyter", "sessionId"]) ||
    !(Date.parse(value.expiresAt) > Date.now()) ||
    !exactKeys(value.jupyter, ["token", "uri"]) ||
    !TOKEN_43.test(value.jupyter.token)
  ) {
    throw new Error("Session access is invalid or expired.");
  }
  validDevTunnelRoot(value.jupyter.uri);
  return {
    sessionId: value.sessionId,
    generation: value.generation,
    expiresAt: value.expiresAt,
    jupyter: { uri: value.jupyter.uri, token: value.jupyter.token },
  };
}

export function cacheSessionAccess(access: ISessionAccess): void {
  const valid = validateSessionAccess(access);
  sessionStorage.setItem(cacheKey(valid.sessionId), JSON.stringify(valid));
}

export function loadSessionAccess(
  sessionId: string,
  generation: string,
): ISessionAccess | undefined {
  if (!GENERATION.test(generation)) return undefined;
  const key = cacheKey(sessionId);
  const raw = sessionStorage.getItem(key);
  if (!raw) return undefined;
  try {
    const access = validateSessionAccess(JSON.parse(raw));
    if (access.sessionId !== sessionId || access.generation !== generation) {
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
  sessionStorage.removeItem(cacheKey(sessionId));
}

function cacheKey(sessionId: string): string {
  return `${CACHE_PREFIX}${validSessionId(sessionId)}`;
}
