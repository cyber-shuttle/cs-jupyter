// Types, identifier and URL validation, and the Validator vocabulary
// (vString, vNumber, vObject, ...) cs-plane response shapes are built from;
// vObject matches iff every listed field validates and no other key is
// present. Nothing here depends on the DOM or on cs-plane, so other modules
// can import freely. Optional fields mean not observed or not yet, never a
// stand-in for false or zero.

export type TunnelProvider = "microsoft" | "github";

export interface OAuthCredentials {
  idToken: string;
}

export const SESSION_ID = /^s-[a-f0-9]{12}$/;

export function validSessionId(value: string): string {
  if (!SESSION_ID.test(value)) {
    throw new Error("Invalid session id.");
  }
  return value;
}

export interface ITokenProvider {
  acquireToken(): Promise<OAuthCredentials>;
  invalidateToken?(): void;
}

export const TOKEN_43 = /^[A-Za-z0-9_-]{43}$/;

export const SESSION_STATES = [
  "SUBMITTING",
  "QUEUED",
  "STARTING",
  "READY",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_LAUNCHERS = ["cs-plane", "client"] as const;
type SessionLauncher = (typeof SESSION_LAUNCHERS)[number];

export const VALIDATION_STATUSES = ["PASSED", "FAILED"] as const;
type SessionValidationStatus = (typeof VALIDATION_STATUSES)[number];

export function isTerminal(state: SessionState): boolean {
  return state === "STOPPED" || state === "FAILED";
}

interface IResources {
  cores: number;
  memoryMb: number;
  wallMinutes: number;
  gpuType?: string;
  gpuCount?: number;
}

interface IJobSpec {
  sshHost: string;
  account?: string;
  partition: string;
  rootFolder: string;
  resources: IResources;
}

export interface ISessionCreateRequest extends IJobSpec {
  idempotencyKey: string;
}

export interface ISessionValidation {
  sessionId: string;
  status: SessionValidationStatus;
  script: string;
  message: string;
  stdout?: string;
  stderr?: string;
}

export interface ISession extends IJobSpec {
  id: string;
  seq: number;
  state: SessionState;
  launcher: SessionLauncher;
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
}

export interface IMetricSample {
  at: string;
  memBytes?: number;
  cpuUsageUsec?: number;
  gpus?: IGpuUtilisation[];
}

interface IGpuUtilisation {
  index: number;
  utilPct?: number;
  memUsedMiB?: number;
  memTotalMiB?: number;
}

export interface ISessionSeries {
  sessionId: string;
  samples: IMetricSample[];
}

export interface IRunStats {
  requestedMemory?: string;
  elapsedSeconds?: number;
  maxRss?: string;
  cpuEfficiencyPct?: number;
  memoryEfficiencyPct?: number;
  cores?: number;
}

export interface IRun extends IJobSpec {
  sessionId: string;
  seq: number;
  finalState: SessionState;
  error?: string;
  startedAt?: string;
  endedAt: string;
  stats?: IRunStats;
  samples?: IMetricSample[];
  logs?: ILogLine[];
}

type LogStream = "status" | "stdout" | "stderr";

export interface ILogLine {
  stream: LogStream;
  text: string;
  at: string;
}

export interface ISshHost {
  name: string;
  hostname?: string;
  user?: string;
  port?: number;
  keyId?: string;
  extraDirectives: string[];
  managed?: boolean;
}

export interface ISshKey {
  id: string;
  type: string;
  fingerprint: string;
}

export interface IHostHealth {
  host: string;
  ok: boolean;
  message: string;
}

export interface IGres {
  name: string;
  count: number;
}

export interface IPartition {
  name: string;
  cpuCount: number;
  memoryMb: number;
  gres: IGres[];
}

export interface ISlurmInfo {
  host: string;
  accounts: string[];
  partitions: IPartition[];
  homeDir?: string;
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
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
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

export function validControlApiUrl(configured: string): string {
  const url = parseUrl(
    configured,
    "cybershuttleControlApiUrl must be an absolute control API URL.",
  );
  assertSecureOrLoopback(
    url,
    "https:",
    "http:",
    "cybershuttleControlApiUrl is invalid; it must use HTTPS or loopback HTTP without credentials, query, or fragment.",
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

export type Validator<T> = (value: unknown) => value is T;

export function vString(pattern?: RegExp): Validator<string> {
  return (v): v is string =>
    typeof v === "string" && (!pattern || pattern.test(v));
}

export const vBoolean: Validator<boolean> = (v): v is boolean =>
  typeof v === "boolean";

export const vNumber: Validator<number> = (v): v is number =>
  typeof v === "number";

export function vBoundedInt(
  minimum: number,
  maximum: number,
): Validator<number> {
  return (v): v is number =>
    typeof v === "number" &&
    Number.isSafeInteger(v) &&
    v >= minimum &&
    v <= maximum;
}

export const vPositiveInt = vBoundedInt(1, Number.MAX_SAFE_INTEGER);

export function vOptional<T>(field: Validator<T>): Validator<T | undefined> {
  return (v): v is T | undefined => v === undefined || field(v);
}

export function vArray<T>(
  of: Validator<T>,
  maxLength?: number,
): Validator<T[]> {
  return (v): v is T[] =>
    Array.isArray(v) &&
    (maxLength === undefined || v.length <= maxLength) &&
    v.every((item) => of(item));
}

export function vOneOf<T extends string | boolean>(
  options: readonly T[],
): Validator<T> {
  return (v): v is T => (options as readonly unknown[]).includes(v);
}

export function vEither<T>(...shapes: Validator<T>[]): Validator<T> {
  return (v): v is T => shapes.some((shape) => shape(v));
}

export function vObject<T>(fields: {
  [K in keyof T]: Validator<T[K]>;
}): Validator<T> {
  const keys = Object.keys(fields);
  return (v): v is T =>
    isPlainObject(v) &&
    Object.keys(v).every((key) => keys.includes(key)) &&
    keys.every((key) =>
      (fields as Record<string, Validator<unknown>>)[key](
        (v as Record<string, unknown>)[key],
      ),
    );
}

export function expect<T>(
  shape: Validator<T>,
  what: string,
): (value: unknown) => T {
  return (value) => {
    if (!shape(value)) {
      throw new Error(`cs-plane returned an invalid ${what}.`);
    }
    return value;
  };
}
