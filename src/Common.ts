// Types, identifier and URL validation, and small response and object helpers
// shared across the extension. Nothing here depends on the DOM or on cs-control,
// so other modules can import freely. Optional fields mean not observed or not
// yet, never a stand-in for false or zero.

export interface OAuthCredentials {
  accessToken: string;
  idToken: string;
}

export const SESSION_ID = /^s-[a-f0-9]{12}$/;
export const GENERATION = /^g-[a-f0-9]{16}$/;

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

export const VALIDATION_STATUSES = ["PASSED", "FAILED"] as const;
export type SessionValidationStatus = (typeof VALIDATION_STATUSES)[number];

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
  generation: string;
  state: SessionState;
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
}

export const SESSION_KEYS = [
  "id",
  "generation",
  "state",
  "sshHost",
  "account",
  "partition",
  "rootFolder",
  "resources",
  "error",
  "createdAt",
  "startedAt",
  "updatedAt",
] as const satisfies readonly (keyof ISession)[];

const sessionKeysCoverISession: [
  Exclude<keyof ISession, (typeof SESSION_KEYS)[number]>,
] extends [never]
  ? true
  : false = true;
void sessionKeysCoverISession;

export interface IMetricSample {
  at: string;
  memBytes?: number;
  cpuUsageUsec?: number;
  gpus?: IGpuUtilisation[];
}

interface IGpuUtilisation {
  utilPct: number;
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
  generation: string;
  finalState: SessionState;
  error?: string;
  startedAt?: string;
  endedAt: string;
  stats?: IRunStats;
  samples?: IMetricSample[];
  logs?: ILogLine[];
}

export type LogStream = "status" | "stdout" | "stderr";

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
  identityFile?: string;
  extraDirectives: string[];
  managed?: boolean;
}

export interface ISshHostTest {
  host: string;
  ok: boolean;
  message: string;
}

interface IGres {
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

export function exactKeys(
  value: unknown,
  expected: string[],
): value is Record<string, any> {
  return (
    onlyKeys(value, expected) && Object.keys(value).length === expected.length
  );
}

export function onlyKeys(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, any> {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
