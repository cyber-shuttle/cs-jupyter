const CACHE_PREFIX = "cybershuttle.runtime-access.v1.";
import { GENERATION, RUNTIME_ID, exactKeys, parseUrl } from "./Common";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface IRuntimeAccess {
  runtimeId: string;
  generation: string;
  expiresAt: string;
  jupyter: { uri: string; token: string };
}

// A Dev Tunnel forwarding root and nothing else: no credentials in the URL, no path, no port.
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

export function validateRuntimeAccess(value: unknown): IRuntimeAccess {
  if (
    !exactKeys(value, ["expiresAt", "generation", "jupyter", "runtimeId"]) ||
    !(Date.parse(value.expiresAt) > Date.now()) ||
    !exactKeys(value.jupyter, ["token", "uri"]) ||
    !TOKEN.test(value.jupyter.token)
  ) {
    throw new Error("Runtime access is invalid or expired.");
  }
  validDevTunnelRoot(value.jupyter.uri);
  return {
    runtimeId: value.runtimeId,
    generation: value.generation,
    expiresAt: value.expiresAt,
    jupyter: { uri: value.jupyter.uri, token: value.jupyter.token },
  };
}

export function cacheRuntimeAccess(access: IRuntimeAccess): void {
  const valid = validateRuntimeAccess(access);
  sessionStorage.setItem(cacheKey(valid.runtimeId), JSON.stringify(valid));
}

export function loadRuntimeAccess(
  runtimeId: string,
  generation: string,
): IRuntimeAccess | undefined {
  if (!GENERATION.test(generation)) return undefined;
  const key = cacheKey(runtimeId);
  const raw = sessionStorage.getItem(key);
  if (!raw) return undefined;
  try {
    const access = validateRuntimeAccess(JSON.parse(raw));
    if (access.runtimeId !== runtimeId || access.generation !== generation) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    return access;
  } catch {
    sessionStorage.removeItem(key);
    return undefined;
  }
}

export function clearRuntimeAccess(runtimeId: string): void {
  sessionStorage.removeItem(cacheKey(runtimeId));
}

function cacheKey(runtimeId: string): string {
  if (!RUNTIME_ID.test(runtimeId)) throw new Error("Invalid runtime id.");
  return `${CACHE_PREFIX}${runtimeId}`;
}
