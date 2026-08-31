import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import {
  AuthClient,
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
  validateRuntimeAccess,
  validDevTunnelRoot,
} from "./runtime-access";
import {
  IRuntime,
  IRuntimeCreateRequest,
  IRuntimeValidation,
  ISlurmInfo,
  ISshHost,
  ISshHostTest,
  RUNTIME_ID,
  RUNTIME_STATES,
  RuntimeState,
  RuntimeValidationStatus,
  VALIDATION_STATUSES,
  exactKeys,
  isPlainObject,
  onlyKeys,
  requestUrl,
} from "./Common";

const RUNTIME_LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type RuntimeLogStream = "status" | "stdout" | "stderr";

export interface IRuntimeLogLine {
  stream: RuntimeLogStream;
  text: string;
  at: string;
}

export interface IRuntimeLogTail {
  runtimeId: string;
  lines: IRuntimeLogLine[];
}

// cs-control answers 304 while the owner-filtered list and its tails are
// byte-identical to the last poll: nothing to parse, nothing to re-render.
export const UNCHANGED = Symbol("cs-control runtime list unchanged");

export interface IRuntimeList {
  runtimes: IRuntime[];
  logs: IRuntimeLogTail[];
}

export interface ITokenProvider {
  acquireToken(): Promise<OAuthCredentials>;
  invalidateToken?(): void;
}

export interface IControlAuth extends ITokenProvider {
  interactiveLogin(): Promise<OAuthCredentials>;
  readonly account?: string | undefined;
}

export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const needsSshLogin = (error: unknown): boolean =>
  error instanceof ControlError && error.code === "ssh_authentication_required";

export { validControlApiUrl } from "./AuthClient";

export function safeControlFetch(
  controlApiUrl: string,
  auth: ITokenProvider,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  const controlOrigin = new URL(validControlApiUrl(controlApiUrl)).origin;
  return async (input, init = {}) => {
    const url = new URL(requestUrl(input));
    if (url.origin !== controlOrigin) {
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
    return response;
  };
}

export class ControlClient {
  private _base: string;
  private _fetch: typeof globalThis.fetch;
  private _webSockets: OAuthWebSocketFactory;
  private _auth: IControlAuth;
  // Describes the list its holder already has, so entering or leaving a session
  // drops it: a fresh panel has no list to revalidate, and a 304 leaves it empty.
  private _runtimesTag: string | undefined;

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
    this._runtimesTag = undefined;
    await this._auth.interactiveLogin();
  }

  // Succeeds only on a still-valid credential, so a caller can tell a resumable
  // session from one needing the device-code round trip.
  async resumeSession(): Promise<void> {
    this._runtimesTag = undefined;
    await this._auth.acquireToken();
  }

  get account(): string | undefined {
    return this._auth.account;
  }

  signOut(): void {
    this._runtimesTag = undefined;
    this._auth.invalidateToken?.();
  }

  async listSshHosts(): Promise<ISshHost[]> {
    const value = await this._request("ssh");
    if (!isPlainObject(value) || !Array.isArray(value.hosts)) {
      throw new Error("cs-control returned an invalid SSH host list.");
    }
    return value.hosts.map(validateHost);
  }

  // cs-control parses the pasted command; the browser composes no SSH config.
  async addSshHost(name: string, command: string): Promise<ISshHost> {
    return validateHost(
      await this._request("ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command }),
      }),
    );
  }

  async removeSshHost(alias: string): Promise<void> {
    await this._request(`ssh/${encodeURIComponent(alias)}`, {
      method: "DELETE",
    });
  }

  async testSshHost(alias: string): Promise<ISshHostTest> {
    const value = await this._request(`ssh/${encodeURIComponent(alias)}/test`, {
      method: "POST",
    });
    if (
      !isPlainObject(value) ||
      typeof value.ok !== "boolean" ||
      typeof value.message !== "string"
    ) {
      throw new Error("cs-control returned an invalid SSH host test.");
    }
    return { ok: value.ok, message: value.message };
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

  // Answers UNCHANGED while cs-control's reply is byte-identical to the last, as
  // it is for most of a queued job's life. `cache: "no-store"` stops the browser
  // revalidating on its own, so the conditional request is made here.
  async listRuntimes(): Promise<IRuntimeList | typeof UNCHANGED> {
    const response = await this._fetch(
      URLExt.join(this._base, "runtimes"),
      this._runtimesTag
        ? { headers: { "If-None-Match": this._runtimesTag } }
        : {},
    );
    if (response.status === 304) {
      return UNCHANGED;
    }
    if (!response.ok) {
      await this._fail(response);
    }
    const value = await this._json(response);
    if (
      !isPlainObject(value) ||
      !Array.isArray(value.runtimes) ||
      !(value.logs === undefined || Array.isArray(value.logs))
    ) {
      throw new Error("cs-control returned an invalid runtime list.");
    }
    this._runtimesTag = response.headers.get("ETag") ?? undefined;
    return {
      runtimes: value.runtimes.map(validateRuntime),
      logs: (value.logs ?? []).map(validateRuntimeLogTail),
    };
  }

  // The script alone, readable while Slurm is being asked about it.
  async previewRuntimeScript(
    request: IRuntimeCreateRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    const value = await this._request("runtimes/script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!isPlainObject(value) || typeof value.script !== "string") {
      throw new Error("cs-control returned an invalid runtime script.");
    }
    return value.script;
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
      await this._request(`runtimes/${encodeURIComponent(id)}`),
    );
  }

  async startRuntime(id: string): Promise<IRuntime> {
    return this._runtimeAction(id, "start", "POST", "started");
  }

  async stopRuntime(id: string): Promise<IRuntime> {
    return this._runtimeAction(id, "stop", "POST", "stopped");
  }

  async deleteRuntime(id: string): Promise<IRuntime> {
    return this._runtimeAction(id, "", "DELETE", "deleted");
  }

  // Start, stop, and delete differ only in the route and the word for what came
  // back. All three must answer with the runtime they were asked about, and all
  // three end the browser's session with the allocation it had.
  private async _runtimeAction(
    id: string,
    suffix: string,
    method: string,
    past: string,
  ): Promise<IRuntime> {
    const runtimeId = validRuntimeId(id);
    const path = `runtimes/${encodeURIComponent(runtimeId)}${suffix ? `/${suffix}` : ""}`;
    const runtime = validateRuntime(await this._request(path, { method }));
    if (runtime.id !== runtimeId) {
      throw new Error(`cs-control returned an invalid ${past} runtime.`);
    }
    clearRuntimeAccess(runtimeId);
    return runtime;
  }

  async getRuntimeAccess(id: string): Promise<IRuntimeAccess> {
    const access = validateRuntimeAccess(
      await this._request(`runtimes/${encodeURIComponent(id)}/access`),
    );
    if (access.runtimeId !== id) {
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

  private async _fail(response: Response): Promise<never> {
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

  private async _json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new Error("cs-control returned invalid JSON.");
    }
  }

  private async _request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this._fetch(URLExt.join(this._base, path), init);
    if (!response.ok) {
      await this._fail(response);
    }
    return this._json(response);
  }
}

// A kernel spec reports its logos as paths on the runtime, but an <img> cannot
// carry the identity token: unauthenticated the runtime answers with its login
// page, and its static handler refuses the preflight an Authorization header
// forces. A token in the URL is the one thing that would work and the one thing
// that must never happen, so the launcher falls back to its built-in icon.
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
  const baseUrl = validDevTunnelRoot(access.jupyter.uri).origin + "/";
  const browserFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const invalidatingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    if (response.status === 401 || response.status === 403) {
      clearRuntimeAccess(access.runtimeId);
      return response;
    }
    if (response.ok && requestUrl(input).includes("/api/kernelspecs")) {
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
  if (!RUNTIME_ID.test(value)) {
    throw new Error("Invalid runtime id.");
  }
  return value;
}

function validateRuntimeValidation(value: unknown): IRuntimeValidation {
  if (
    !onlyKeys(value, [
      "runtimeId",
      "status",
      "script",
      "message",
      "stdout",
      "stderr",
    ]) ||
    !VALIDATION_STATUSES.includes(value.status as RuntimeValidationStatus)
  ) {
    throw new Error("cs-control returned an invalid runtime validation.");
  }
  return value as IRuntimeValidation;
}

function validateRuntimeLogTail(value: unknown): IRuntimeLogTail {
  if (
    !isPlainObject(value) ||
    typeof value.runtimeId !== "string" ||
    !RUNTIME_ID.test(value.runtimeId) ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 100 ||
    !exactKeys(value, ["runtimeId", "lines"])
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
      typeof line.at !== "string" ||
      !exactKeys(line, ["stream", "text", "at"])
    ) {
      throw new Error("cs-control returned an invalid runtime log line.");
    }
    const size = encoder.encode(line.text).byteLength;
    bytes += size;
    if (size > 4096 || bytes > 64 * 1024) {
      throw new Error("cs-control returned an oversized runtime log event.");
    }
    return {
      stream: line.stream as RuntimeLogStream,
      text: line.text,
      at: line.at,
    };
  });
  return { runtimeId: value.runtimeId, lines };
}

function validateRuntime(value: unknown): IRuntime {
  if (
    !onlyKeys(value, [
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
    ]) ||
    !RUNTIME_STATES.includes(value.state as RuntimeState) ||
    !isPlainObject(value.resources)
  ) {
    throw new Error("cs-control returned an invalid runtime.");
  }
  return value as unknown as IRuntime;
}

function validateHost(value: unknown): ISshHost {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.extraDirectives)
  ) {
    throw new Error("cs-control returned an invalid SSH host.");
  }
  return value as unknown as ISshHost;
}

export function validateSlurmResource(value: unknown): ISlurmInfo {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.accounts) ||
    !Array.isArray(value.partitions) ||
    !value.partitions.every(
      (part) => isPlainObject(part) && Array.isArray(part.gres),
    )
  ) {
    throw new Error("cs-control returned invalid SLURM discovery.");
  }
  return value as unknown as ISlurmInfo;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
