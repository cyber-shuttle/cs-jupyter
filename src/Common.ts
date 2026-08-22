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
  runtimeId: string;
  status: RuntimeValidationStatus;
  script: string;
  message: string;
  stdout?: string;
  stderr?: string;
}

export interface IRuntime extends IAllocation {
  id: string;
  generation: string;
  state: RuntimeState;
  error?: string;
  createdAt: string;
  updatedAt: string;
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

// One rule for both the control API URL and the WebSocket URL.
export function assertSecureOrLoopback(
  url: URL,
  secure: string,
  insecure: string,
  message: string,
): void {
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
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
