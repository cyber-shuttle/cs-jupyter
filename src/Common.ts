// Types, URL validation and the CyberShuttle API's error envelope. Wire shapes
// are the server's own, generated into src/api by `bun run types`, and the
// typed `data` openapi-fetch returns is trusted as is; the view types here are
// only those the UI derives (a usage sample, a log line).
import createClient from "openapi-fetch";
import type { components, paths } from "./api/airavata";

export type Schemas = components["schemas"];
export type PlaneApi = ReturnType<typeof createClient<paths>>;

// The spec's paths carry `/api/v1`, so the client is rooted at the server, not the API URL.
export const planeApi = (
  base: string,
  fetch: typeof globalThis.fetch,
): PlaneApi =>
  createClient<paths>({ baseUrl: base.replace(/\/api\/v1$/, ""), fetch });

export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw await planeError(response, error);
  return data as T;
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IPlaneAuth {
  acquireToken(): Promise<string>;
  invalidateToken(): void;
  signIn(): Promise<void>;
  readonly identity?: string | undefined;
}

export type SessionState = Schemas["ProcessStatusType"];

// The job has begun; RUNNING can follow READY, since Slurm reports the begin late.
export const isRunning = (state: SessionState): boolean =>
  state === "READY" || state === "RUNNING";

export type ISession = Schemas["SessionResponse"];
export type IRun = Schemas["SessionRun"];
export interface IUsageReport {
  memBytes?: number;
  cpuUsageUsec?: number;
  gpus?: Array<{ utilPct?: number }>;
}
export type IUsageSample = IUsageReport & { at: number };
export type ILogLine = { text: string; at: string };
export interface IGres {
  name: string;
  count: number;
}
export interface IPartition {
  name: string;
  cpuCount?: number;
  memoryMb?: number;
  gres: IGres[];
}
export interface ISlurmInfo {
  configId: string;
  accounts: string[];
  partitions: IPartition[];
}

export type IDeployment = Schemas["BatchDeploymentResponse"] & { name: string };

export const configName = (
  config: Schemas["SlurmClusterConfigResponse"],
): string =>
  config.name ||
  config.slurmCluster?.clusterName ||
  config.slurmClusterConfigId;

export const configLogin = (
  config: Schemas["SlurmClusterConfigResponse"],
): string =>
  [config.loginUser, config.sshCredential?.sshCredentialName]
    .filter(Boolean)
    .join(" · ");

export function clusterLabel(
  clusters: readonly Schemas["SlurmClusterConfigResponse"][],
  id: string,
): string {
  const config = clusters.find((each) => each.slurmClusterConfigId === id);
  return config ? configName(config) : id;
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUrl(value: string, message: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(message);
  }
}

export const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

export function assertSecureOrLoopback(
  url: URL,
  secure: string,
  insecure: string,
  message: string,
): void {
  const loopback =
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost");
  if (
    (url.protocol !== secure && !(url.protocol === insecure && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(message);
  }
}

export function validPlaneApiUrl(configured: string): string {
  const url = parseUrl(
    configured,
    "cybershuttlePlaneApiUrl must be an absolute CyberShuttle API URL.",
  );
  assertSecureOrLoopback(
    url,
    "https:",
    "http:",
    "cybershuttlePlaneApiUrl is invalid; it must use HTTPS or loopback HTTP without credentials, query, or fragment.",
  );
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function jsonResponse(
  value: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" },
  });
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function planeError(
  response: Response,
  body?: unknown,
): Promise<PlaneError> {
  const value: any = body ?? (await response.json().catch(() => undefined));
  const message = [value?.message, value?.error].find(
    (v) => typeof v === "string",
  );
  return new PlaneError(
    message ?? `The server returned ${response.status}`,
    response.status,
  );
}
