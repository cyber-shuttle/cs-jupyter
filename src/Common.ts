// The two identifier formats cs-control issues. Written once here for the same
// reason as the state list below: a change to either must not half-land.
export const RUNTIME_ID = /^rt-[a-f0-9]{12}$/;
export const GENERATION = /^g-[a-f0-9]{16}$/;

// Types are derived from these values so validation and the type system cannot
// disagree about what cs-control is allowed to report.
export const RUNTIME_STATES = [
  "SUBMITTING",
  "QUEUED",
  "STARTING",
  "READY",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const VALIDATION_STATUSES = ["PASSED", "FAILED"] as const;
export type RuntimeValidationStatus = (typeof VALIDATION_STATUSES)[number];

export function isTerminal(state: RuntimeState): boolean {
  return state === "STOPPED" || state === "FAILED";
}

export interface IResources {
  cores: number;
  memoryMb: number;
  wallMinutes: number;
  gpuType?: string;
  gpuCount?: number;
}

export interface IAllocation {
  sshHost: string;
  account?: string;
  partition: string;
  rootFolder: string;
  resources: IResources;
}

export interface IRuntimeCreateRequest extends IAllocation {
  idempotencyKey: string;
}

export interface IRuntimeValidation {
  status: RuntimeValidationStatus;
  script: string;
  message: string;
  stderr?: string;
}

export interface IRuntime extends IAllocation {
  id: string;
  generation: string;
  state: RuntimeState;
  error?: string;
  createdAt: string;
  // When Slurm was first seen running the allocation. Absent until it starts,
  // so a queue wait is never mistaken for a countdown.
  startedAt?: string;
  updatedAt: string;
}

export const RUNTIME_KEYS = [
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
] as const satisfies readonly (keyof IRuntime)[];

export const runtimeKeysCoverIRuntime: [
  Exclude<keyof IRuntime, (typeof RUNTIME_KEYS)[number]>,
] extends [never]
  ? true
  : false = true;

// One reading of what an allocation is actually using. Every figure is optional:
// a host with no GPUs reports none, and a cgroup file that cannot be read is
// absent rather than zero, which for a cumulative counter is a different claim.
export interface IMetricSample {
  at: string;
  memBytes?: number;
  cpuUsageUsec?: number;
  gpus?: IGpuSample[];
}

export interface IGpuSample {
  index: number;
  utilPct: number;
  memUsedMiB: number;
  memTotalMiB: number;
}

export interface IRuntimeSeries {
  runtimeId: string;
  samples: IMetricSample[];
}

// What Slurm's accounting says a finished allocation used. Absent until the
// flush lands, so every figure is optional.
export interface IRunStats {
  cores?: number;
  requestedMemory?: string;
  elapsedSeconds?: number;
  maxRss?: string;
  cpuEfficiencyPct?: number;
  memoryEfficiencyPct?: number;
}

// What one finished allocation did. A run is named by the generation that ran
// it, so a card accumulates runs rather than overwriting them.
export interface IRun extends IAllocation {
  runtimeId: string;
  generation: string;
  finalState: string;
  error?: string;
  startedAt?: string;
  endedAt: string;
  stats?: IRunStats;
  samples?: IMetricSample[];
}

export interface ISshHost {
  name: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  extraDirectives: string[];
  // Only entries CyberShuttle wrote can be removed from here; the rest are the
  // user's own configuration.
  managed?: boolean;
}

export interface ISshHostTest {
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
  homeDir: string;
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

// One rule for both the control API URL and the WebSocket URL.
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

// Two questions a response is asked: is this exactly these keys, and does it
// carry anything outside this list. The second permits an absent optional field,
// so they are not interchangeable.
export function exactKeys(
  value: unknown,
  expected: string[],
): value is Record<string, any> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
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
