import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import {
  AuthClient,
  AuthInteractionRequiredError,
  validControlApiUrl,
  type OAuthCredentials,
} from "./AuthClient";
import {
  OAuthWebSocketFactory,
  type OAuthWebSocketConnector,
} from "./OAuthWebSocket";
import type { IRuntimeAccess } from "./runtime-access";
import {
  clearRuntimeAccess,
  clearRuntimeSession,
  validateRuntimeAccess,
  validDevTunnelRoot,
} from "./runtime-access";
import {
  IRuntime,
  IRuntimeCreateRequest,
  IRuntimeValidation,
  ISlurmInfo,
  ISshHost,
  RUNTIME_STATES,
  RuntimeState,
  RuntimeValidationStatus,
  VALIDATION_STATUSES,
} from "./Common";
import { isPlainObject } from "./Common";

const ID = /^rt-[a-f0-9]{12}$/;
const GENERATION = /^g-[a-f0-9]{16}$/;
const RUNTIME_LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_CORES = 4096;
const MAX_MEMORY_MB = 100_000_000;
const MAX_WALL_MINUTES = 525_600;

export type RuntimeLogStream = "status" | "stdout" | "stderr";

export interface IRuntimeLogLine {
  stream: RuntimeLogStream;
  text: string;
}

export interface IRuntimeLogTail {
  runtimeId: string;
  lines: IRuntimeLogLine[];
}

export interface IRuntimeList {
  runtimes: IRuntime[];
  refreshing: boolean;
  logs: IRuntimeLogTail[];
}

export interface ITokenProvider {
  acquireToken(): Promise<OAuthCredentials>;
  invalidateToken?(): void;
}

export interface IControlAuth extends ITokenProvider {
  interactiveLogin(): Promise<OAuthCredentials>;
}

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export { validControlApiUrl } from "./AuthClient";

export function safeControlFetch(
  controlApiUrl: string,
  auth: ITokenProvider,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  const controlOrigin = new URL(validControlApiUrl(controlApiUrl)).origin;
  return async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.origin !== controlOrigin || !/^https?:$/.test(url.protocol)) {
      throw new Error(
        "CyberShuttle blocked a request outside the configured control origin.",
      );
    }
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const credentials = await auth.acquireToken();
    headers.set("Authorization", `Bearer ${credentials.accessToken}`);
    headers.set("X-CyberShuttle-Identity", credentials.idToken);
    headers.delete("X-XSRFToken");
    const response = await fetch(input, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      auth.invalidateToken?.();
    }
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && new URL(response.url).origin !== controlOrigin)
    )
      throw new Error("CyberShuttle service redirects are not allowed.");
    return response;
  };
}

export class ControlClient {
  private _base: string;
  private _fetch: typeof globalThis.fetch;
  private _webSockets: OAuthWebSocketFactory;
  private _auth: IControlAuth;

  constructor(
    base = PageConfig.getOption("cybershuttleControlApiUrl"),
    auth: IControlAuth = new AuthClient(),
    fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
    webSockets?: OAuthWebSocketFactory,
  ) {
    this._base = validControlApiUrl(base);
    this._auth = auth;
    this._fetch = safeControlFetch(this._base, auth, fetch);
    this._webSockets =
      webSockets ?? new OAuthWebSocketFactory(auth, new URL(this._base).origin);
  }

  async signIn(): Promise<void> {
    await this._auth.interactiveLogin();
  }

  // Succeeds only on a credential that is still valid, so callers can tell a
  // resumable session from one that needs the device-code round trip.
  async resumeSession(): Promise<void> {
    await this._auth.acquireToken();
  }

  async listSshHosts(): Promise<ISshHost[]> {
    const value = await this._request("ssh");
    if (!isPlainObject(value) || !Array.isArray(value.hosts)) {
      throw new Error("cs-control returned an invalid SSH host list.");
    }
    return value.hosts.map(validateHost);
  }

  // Aborting the signal cancels the request, which cancels the remote process group.
  async discoverSlurm(
    alias: string,
    signal?: AbortSignal,
  ): Promise<ISlurmInfo> {
    return validateSlurmResource(
      await this._request(`ssh/${encodeURIComponent(alias)}/slurm`, { signal }),
    );
  }

  sshAuthWebSocket(alias: string): OAuthWebSocketConnector {
    return this._webSocketConnector(`ssh/${encodeURIComponent(alias)}/auth`);
  }

  async listRuntimes(): Promise<IRuntimeList> {
    const value = await this._request("runtimes");
    if (
      !isPlainObject(value) ||
      !Array.isArray(value.runtimes) ||
      typeof value.refreshing !== "boolean" ||
      !(value.logs === undefined || Array.isArray(value.logs))
    ) {
      throw new Error("cs-control returned an invalid runtime list.");
    }
    return {
      runtimes: value.runtimes.map(validateRuntime),
      refreshing: value.refreshing,
      logs: (value.logs ?? []).map(validateRuntimeLogTail),
    };
  }

  async validateRuntime(
    request: IRuntimeCreateRequest,
    signal?: AbortSignal,
  ): Promise<IRuntimeValidation> {
    return validateRuntimeValidation(
      await this._request("runtimes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      }),
    );
  }

  async createRuntime(request: IRuntimeCreateRequest): Promise<IRuntime> {
    return validateRuntime(
      await this._request("runtimes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }

  async getRuntime(id: string): Promise<IRuntime> {
    return validateRuntime(
      await this._request(`runtimes/${encodeURIComponent(validRuntimeId(id))}`),
    );
  }

  async stopRuntime(id: string): Promise<IRuntime> {
    const runtimeId = validRuntimeId(id);
    const invalid = "cs-control returned an invalid stopped runtime.";
    let runtime: IRuntime;
    try {
      runtime = validateRuntime(
        await this._request(`runtimes/${encodeURIComponent(runtimeId)}/stop`, {
          method: "POST",
        }),
      );
    } catch (error) {
      if (error instanceof ControlError) {
        throw error;
      }
      throw new Error(invalid);
    }
    if (runtime.id !== runtimeId) {
      throw new Error(invalid);
    }
    clearRuntimeSession(runtimeId);
    return runtime;
  }

  // Delete stops a live allocation first, so it can take as long as a stop.
  async deleteRuntime(id: string): Promise<IRuntime> {
    const runtimeId = validRuntimeId(id);
    const invalid = "cs-control returned an invalid deleted runtime.";
    let runtime: IRuntime;
    try {
      runtime = validateRuntime(
        await this._request(`runtimes/${encodeURIComponent(runtimeId)}`, {
          method: "DELETE",
        }),
      );
    } catch (error) {
      if (error instanceof ControlError) {
        throw error;
      }
      throw new Error(invalid);
    }
    if (runtime.id !== runtimeId) {
      throw new Error(invalid);
    }
    clearRuntimeSession(runtimeId);
    return runtime;
  }

  async getRuntimeAccess(id: string): Promise<IRuntimeAccess> {
    const runtimeId = validRuntimeId(id);
    const access = validateRuntimeAccess(
      await this._request(`runtimes/${encodeURIComponent(runtimeId)}/access`),
    );
    if (access.runtimeId !== runtimeId) {
      throw new Error("cs-control returned access for a different runtime.");
    }
    return access;
  }

  private _webSocketConnector(path: string): OAuthWebSocketConnector {
    const url = new URL(URLExt.join(this._base, path));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = url.toString();
    return () => this._webSockets.open(endpoint);
  }

  private async _request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this._fetch(URLExt.join(this._base, path), init);
    if (!response.ok) {
      let message = `cs-control returned ${response.status}`;
      let code = "request_failed";
      try {
        const value = await response.json();
        if (isPlainObject(value) && isPlainObject(value.error)) {
          if (typeof value.error.code === "string") {
            code = value.error.code;
          }
          if (typeof value.error.message === "string") {
            message = value.error.message;
          }
        }
      } catch {
        // Keep the status-only error.
      }
      throw new ControlError(code, message);
    }
    try {
      return await response.json();
    } catch {
      throw new Error("cs-control returned invalid JSON.");
    }
  }
}

// Jupyter Server owns its own auth, so ServerConnection's built-in token handling is the whole
// integration: the Authorization header on REST and ?token= on WebSocket URLs.
// A kernel spec reports its logos as paths on the runtime, but an <img> cannot
// carry the identity token: unauthenticated the runtime answers with its login
// page, and its static handler refuses the cross-origin preflight that an
// Authorization header forces. Putting the token in the URL is the one thing
// that would work and the one thing that must never happen, so drop the
// resources and let the launcher fall back to its built-in kernel icon rather
// than render a broken image.
async function withoutUnreachableKernelSpecLogos(
  response: Response,
): Promise<Response> {
  const payload: unknown = await response.json();
  if (isPlainObject(payload) && isPlainObject(payload.kernelspecs)) {
    for (const spec of Object.values(payload.kernelspecs)) {
      if (isPlainObject(spec)) {
        spec.resources = {};
      }
    }
  }
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": "application/json" },
  });
}

export function createRuntimeServerSettings(
  descriptor: IRuntimeAccess,
  options: { fetch?: typeof globalThis.fetch } = {},
): ServerConnection.ISettings {
  const access = validateRuntimeAccess(descriptor);
  const baseUrl =
    validDevTunnelRoot(access.jupyter.uri, "Jupyter URI").origin + "/";
  const browserFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const invalidatingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    if (response.status === 401 || response.status === 403) {
      clearRuntimeAccess(access.runtimeId);
      return response;
    }
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (response.ok && url.includes("/api/kernelspecs")) {
      return withoutUnreachableKernelSpecLogos(response);
    }
    return response;
  };
  return ServerConnection.makeSettings({
    appendToken: true,
    baseUrl,
    fetch: invalidatingFetch,
    token: access.jupyter.token,
    wsUrl: baseUrl.replace(/^https:/, "wss:"),
  });
}

export function validRuntimeId(value: string): string {
  if (!ID.test(value)) {
    throw new Error("Invalid runtime id.");
  }
  return value;
}

function validateRuntimeValidation(value: unknown): IRuntimeValidation {
  if (
    !isPlainObject(value) ||
    typeof value.runtimeId !== "string" ||
    !ID.test(value.runtimeId) ||
    !VALIDATION_STATUSES.includes(value.status as RuntimeValidationStatus) ||
    typeof value.script !== "string" ||
    !value.script ||
    typeof value.message !== "string" ||
    !optionalString(value.stdout) ||
    !optionalString(value.stderr) ||
    Object.keys(value).some(
      (key) =>
        ![
          "runtimeId",
          "status",
          "script",
          "message",
          "stdout",
          "stderr",
        ].includes(key),
    )
  ) {
    throw new Error("cs-control returned an invalid runtime validation.");
  }
  return value as IRuntimeValidation;
}

function validateRuntimeLogTail(value: unknown): IRuntimeLogTail {
  if (
    !isPlainObject(value) ||
    typeof value.runtimeId !== "string" ||
    !ID.test(value.runtimeId) ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 100 ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !["runtimeId", "lines"].includes(key))
  ) {
    throw new Error("cs-control returned an invalid runtime log event.");
  }
  let bytes = 0;
  const encoder = new TextEncoder();
  const lines = value.lines.map((line): IRuntimeLogLine => {
    if (
      !isPlainObject(line) ||
      !["status", "stdout", "stderr"].includes(String(line.stream)) ||
      typeof line.text !== "string" ||
      RUNTIME_LOG_CONTROL.test(line.text) ||
      Object.keys(line).length !== 2 ||
      Object.keys(line).some((key) => !["stream", "text"].includes(key))
    ) {
      throw new Error("cs-control returned an invalid runtime log line.");
    }
    const size = encoder.encode(line.text).byteLength;
    bytes += size;
    if (size > 4096 || bytes > 64 * 1024) {
      throw new Error("cs-control returned an oversized runtime log event.");
    }
    return { stream: line.stream as RuntimeLogStream, text: line.text };
  });
  return { runtimeId: value.runtimeId, lines };
}

function validateRuntime(value: unknown): IRuntime {
  const allowed = [
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
    "updatedAt",
  ];
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation) ||
    typeof value.state !== "string" ||
    !RUNTIME_STATES.includes(value.state as RuntimeState) ||
    typeof value.sshHost !== "string" ||
    !value.sshHost ||
    typeof value.partition !== "string" ||
    !value.partition ||
    typeof value.rootFolder !== "string" ||
    !value.rootFolder ||
    !resources(value.resources) ||
    !optionalString(value.account) ||
    !optionalString(value.error) ||
    !date(value.createdAt) ||
    !date(value.updatedAt)
  ) {
    throw new Error("cs-control returned an invalid runtime.");
  }
  return value as unknown as IRuntime;
}

function validateHost(value: unknown): ISshHost {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    !optionalString(value.hostname) ||
    !optionalString(value.user) ||
    !(
      value.port === undefined ||
      (Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535)
    ) ||
    !optionalString(value.identityFile) ||
    !Array.isArray(value.extraDirectives) ||
    !value.extraDirectives.every((item) => typeof item === "string")
  ) {
    throw new Error("cs-control returned an invalid SSH host.");
  }
  return value as unknown as ISshHost;
}

export function validateSlurmResource(value: unknown): ISlurmInfo {
  if (
    !isPlainObject(value) ||
    typeof value.host !== "string" ||
    typeof value.homeDir !== "string" ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every((item) => typeof item === "string") ||
    !Array.isArray(value.partitions) ||
    !value.partitions.every(
      (part) =>
        isPlainObject(part) &&
        typeof part.name === "string" &&
        positiveInteger(part.cpuCount, MAX_CORES) &&
        positiveInteger(part.memoryMb, MAX_MEMORY_MB) &&
        Array.isArray(part.gres) &&
        part.gres.every(
          (item) =>
            isPlainObject(item) &&
            typeof item.name === "string" &&
            positiveInteger(item.count),
        ),
    )
  ) {
    throw new Error("cs-control returned invalid SLURM discovery.");
  }
  return value as unknown as ISlurmInfo;
}

function resources(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !positiveInteger(value.cores, MAX_CORES) ||
    !positiveInteger(value.memoryMb, MAX_MEMORY_MB) ||
    !positiveInteger(value.wallMinutes, MAX_WALL_MINUTES)
  ) {
    return false;
  }
  const hasGpuType = typeof value.gpuType === "string" && value.gpuType !== "";
  const hasGpuCount = positiveInteger(value.gpuCount);
  return (
    (value.gpuType === undefined && value.gpuCount === undefined) ||
    (hasGpuType && hasGpuCount)
  );
}

function positiveInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): boolean {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= maximum
  );
}

function date(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
