// Types, identifier and URL validation, and the Validator vocabulary
// (vString, vNumber, vObject, ...) cs-plane response shapes are built from.
// The shapes are cs-plane's own, generated into src/api by `bun run types`;
// each validator is typed against one, so a field cs-plane adds, drops or
// makes optional fails the build. vObject ignores keys it does not list, so a
// newer cs-plane still validates; strict refuses them, for grants and tokens.
// Optional fields mean not observed or not yet, never a stand-in for false or
// zero.

import type * as plane from "./api/session";
import type * as ssh from "./api/ssh";

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

export const TUNNEL_MODES = ["devtunnel", "websocket"] as const;
export type TunnelMode = (typeof TUNNEL_MODES)[number];
export const TUNNEL_MODE_LABEL: Record<TunnelMode, string> = {
  devtunnel: "Dev Tunnel",
  websocket: "WebSocket",
};

export const VALIDATION_STATUSES = ["PASSED", "FAILED"] as const;
type SessionValidationStatus = (typeof VALIDATION_STATUSES)[number];

export function isTerminal(state: SessionState): boolean {
  return state === "STOPPED" || state === "FAILED";
}

// The generated shapes carry Go's plain strings; Narrow pins the literals cs-plane sends.
export type Narrow<T, N> = Omit<T, keyof N> & N;
type LogStream = "status" | "stdout" | "stderr";
type JobLiterals = { tunnelModes: TunnelMode[] };

export type ISessionCreateRequest = Narrow<
  plane.CreateRequest,
  JobLiterals & { idempotencyKey: string }
>;
export type ISessionValidation = Narrow<
  plane.ValidationResult,
  { status: SessionValidationStatus }
>;
export type ISession = Narrow<
  plane.SessionResponse,
  JobLiterals & { state: SessionState; launcher: SessionLauncher }
>;
export type IMetricSample = plane.MetricSample;
export type ISessionSeries = plane.SessionSeries;
export type IRunStats = plane.RunStats;
export type ILogLine = Narrow<plane.SessionLogLine, { stream: LogStream }>;
export type IRun = Narrow<
  plane.Run,
  JobLiterals & {
    launcher?: SessionLauncher;
    finalState: SessionState;
    logs?: ILogLine[];
  }
>;
export type ISshHost = ssh.HostEntry;
export type ISshKey = ssh.SSHKey;
export type IHostHealth = ssh.HostHealth;
export type IGres = plane.Gres;
export type IPartition = plane.Partition;
export type ISlurmInfo = plane.Resource;

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

export function vObject<T>(
  fields: { [K in keyof T]: Validator<T[K]> },
  strict = false,
): Validator<T> {
  const keys = Object.keys(fields);
  return (v): v is T =>
    isPlainObject(v) &&
    (!strict || Object.keys(v).every((key) => keys.includes(key))) &&
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
