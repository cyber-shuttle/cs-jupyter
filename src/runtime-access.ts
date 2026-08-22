const CACHE_PREFIX = "cybershuttle.runtime-access.v1.";
import { isPlainObject, RUNTIME_ID, GENERATION } from "./Common";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface IRuntimeAccess {
  runtimeId: string;
  generation: string;
  expiresAt: string;
  jupyter: { uri: string; token: string };
}

// A Dev Tunnel forwarding root and nothing else: no credentials in the URL, no path, no port.
export function validDevTunnelRoot(
  value: string,
  label = "Dev Tunnel URI",
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
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
    throw new Error(`${label} is invalid.`);
  }
  return url;
}

export function validateRuntimeAccess(
  value: unknown,
  now = Date.now(),
): IRuntimeAccess {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(",") !==
      "expiresAt,generation,jupyter,runtimeId" ||
    typeof value.runtimeId !== "string" ||
    !RUNTIME_ID.test(value.runtimeId) ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now ||
    !isPlainObject(value.jupyter) ||
    Object.keys(value.jupyter).sort().join(",") !== "token,uri" ||
    typeof value.jupyter.uri !== "string" ||
    typeof value.jupyter.token !== "string" ||
    !TOKEN.test(value.jupyter.token)
  ) {
    throw new Error("Runtime access is invalid or expired.");
  }
  validDevTunnelRoot(value.jupyter.uri, "Jupyter URI");
  return {
    runtimeId: value.runtimeId,
    generation: value.generation,
    expiresAt: value.expiresAt,
    jupyter: { uri: value.jupyter.uri, token: value.jupyter.token },
  };
}

export function cacheRuntimeAccess(
  access: IRuntimeAccess,
  storage: Storage = window.sessionStorage,
): void {
  const valid = validateRuntimeAccess(access);
  storage.setItem(cacheKey(valid.runtimeId), JSON.stringify(valid));
}

export function loadRuntimeAccess(
  runtimeId: string,
  generation: string,
  storage: Storage = window.sessionStorage,
  now = Date.now(),
): IRuntimeAccess | undefined {
  if (!GENERATION.test(generation)) return undefined;
  const key = cacheKey(runtimeId);
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  try {
    const access = validateRuntimeAccess(JSON.parse(raw), now);
    if (access.runtimeId !== runtimeId || access.generation !== generation) {
      storage.removeItem(key);
      return undefined;
    }
    return access;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function clearRuntimeAccess(
  runtimeId: string,
  storage: Storage = window.sessionStorage,
): void {
  storage.removeItem(cacheKey(runtimeId));
}

function cacheKey(runtimeId: string): string {
  if (!RUNTIME_ID.test(runtimeId)) throw new Error("Invalid runtime id.");
  return `${CACHE_PREFIX}${runtimeId}`;
}
