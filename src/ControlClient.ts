// The typed client for cs-control's REST and WebSocket API. Every response is
// validated against Common.ts's shapes before a caller sees it. UNCHANGED marks
// a 304 Not Modified response, meaning the caller's cached copy is still current.
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import { AuthClient } from "./AuthClient";
import type { OAuthCredentials } from "./Common";
import {
  OAuthWebSocketFactory,
  type OAuthWebSocketConnector,
} from "./OAuthWebSocket";
import type { ISessionAccess } from "./session-access";
import {
  clearSessionAccess,
  validateSessionAccess,
  validDevTunnelRoot,
} from "./session-access";
import {
  ILogLine,
  IMetricSample,
  IRun,
  ISession,
  ISessionCreateRequest,
  ISessionSeries,
  ISessionValidation,
  ISlurmInfo,
  ISshHost,
  ISshHostTest,
  ITokenProvider,
  LogStream,
  SESSION_ID,
  SESSION_KEYS,
  SESSION_STATES,
  SessionState,
  SessionValidationStatus,
  VALIDATION_STATUSES,
  exactKeys,
  isPlainObject,
  jsonResponse,
  onlyKeys,
  requestUrl,
  validControlApiUrl,
  validSessionId,
} from "./Common";

const SESSION_LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export interface ISessionLogTail {
  sessionId: string;
  lines: ILogLine[];
}

export const UNCHANGED = Symbol("cs-control session list unchanged");

export interface ISessionList {
  sessions: ISession[];
  logs: ISessionLogTail[];
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

export function safeControlFetch(
  controlApiUrl: string,
  auth: ITokenProvider,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  const controlOrigin = new URL(controlApiUrl).origin;
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
  private _sessionsTag: string | undefined;

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
    this._sessionsTag = undefined;
    await this._auth.interactiveLogin();
  }

  async resumeSignIn(): Promise<void> {
    this._sessionsTag = undefined;
    await this._auth.acquireToken();
  }

  get account(): string | undefined {
    return this._auth.account;
  }

  signOut(): void {
    this._sessionsTag = undefined;
    this._auth.invalidateToken?.();
  }

  async listSshHosts(): Promise<ISshHost[]> {
    const value = await this._request("ssh");
    if (!isPlainObject(value) || !Array.isArray(value.hosts)) {
      throw new Error("cs-control returned an invalid SSH host list.");
    }
    return value.hosts.map(validateHost);
  }

  async addSshHost(name: string, command: string): Promise<ISshHost> {
    return validateHost(
      await this._request("ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command }),
      }),
    );
  }

  async updateSshHost(alias: string, command: string): Promise<ISshHost> {
    return validateHost(
      await this._request(`ssh/${encodeURIComponent(alias)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
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
      typeof value.host !== "string" ||
      typeof value.ok !== "boolean" ||
      typeof value.message !== "string"
    ) {
      throw new Error("cs-control returned an invalid SSH host test.");
    }
    if (value.host !== alias) {
      throw new Error(
        `Received an SSH host test for ${value.host}, not ${alias}.`,
      );
    }
    return { host: value.host, ok: value.ok, message: value.message };
  }

  async discoverSlurm(
    alias: string,
    signal?: AbortSignal,
  ): Promise<ISlurmInfo> {
    const value = validateSlurmResource(
      await this._request(`ssh/${encodeURIComponent(alias)}/slurm`, { signal }),
    );
    if (value.host !== alias) {
      throw new Error(
        `Received Slurm discovery for ${value.host}, not ${alias}.`,
      );
    }
    return value;
  }

  sshAuthWebSocket(alias: string): OAuthWebSocketConnector {
    return this._webSocketConnector(`ssh/${encodeURIComponent(alias)}/auth`);
  }

  async listSessions(): Promise<ISessionList | typeof UNCHANGED> {
    let tag: string | undefined;
    const value = await this._request(
      "sessions",
      {},
      { tag: this._sessionsTag, onTag: (etag) => (tag = etag) },
    );
    if (value === UNCHANGED) {
      return UNCHANGED;
    }
    if (
      !isPlainObject(value) ||
      !Array.isArray(value.sessions) ||
      !(value.logs === undefined || Array.isArray(value.logs))
    ) {
      throw new Error("cs-control returned an invalid session list.");
    }
    const sessions = value.sessions.map(validateSession);
    const logs = (value.logs ?? []).map(validateSessionLogTail);
    this._sessionsTag = tag;
    return { sessions, logs };
  }

  async validateCreateRequest(
    request: ISessionCreateRequest,
    signal?: AbortSignal,
  ): Promise<ISessionValidation> {
    return validateSessionValidation(
      await this._request("sessions/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      }),
    );
  }

  async createSession(request: ISessionCreateRequest): Promise<ISession> {
    return validateSession(
      await this._request("sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
  }

  async getSession(id: string): Promise<ISession> {
    const session = validateSession(
      await this._request(`sessions/${encodeURIComponent(id)}`),
    );
    if (session.id !== id) {
      throw new Error("cs-control returned a different session.");
    }
    return session;
  }

  async startSession(id: string): Promise<ISession> {
    return this._sessionAction(id, "start", "POST", "started");
  }

  async stopSession(id: string): Promise<ISession> {
    return this._sessionAction(id, "stop", "POST", "stopped");
  }

  async deleteSession(id: string): Promise<ISession> {
    return this._sessionAction(id, "", "DELETE", "deleted");
  }

  private async _sessionAction(
    id: string,
    suffix: string,
    method: string,
    past: string,
  ): Promise<ISession> {
    const sessionId = validSessionId(id);
    const path = `sessions/${encodeURIComponent(sessionId)}${suffix ? `/${suffix}` : ""}`;
    const session = validateSession(await this._request(path, { method }));
    if (session.id !== sessionId) {
      throw new Error(`cs-control returned an invalid ${past} session.`);
    }
    clearSessionAccess(sessionId);
    return session;
  }

  async getSessionMetrics(id: string): Promise<ISessionSeries> {
    return validateSessionSeries(
      await this._request(
        `sessions/${encodeURIComponent(validSessionId(id))}/metrics`,
      ),
    );
  }

  async listRuns(): Promise<IRun[]> {
    const value = await this._request("sessions/history");
    if (!isPlainObject(value) || !Array.isArray(value.runs)) {
      throw new Error("cs-control returned an invalid run history.");
    }
    return value.runs.map(validateRun);
  }

  async getSessionAccess(id: string): Promise<ISessionAccess> {
    const sessionId = validSessionId(id);
    const access = validateSessionAccess(
      await this._request(`sessions/${encodeURIComponent(sessionId)}/access`),
    );
    if (access.sessionId !== sessionId) {
      throw new Error("cs-control returned access for a different session.");
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
    } catch {}
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
    unless304?: {
      tag: string | undefined;
      onTag: (tag: string | undefined) => void;
    },
  ): Promise<unknown> {
    const headers = unless304?.tag
      ? { ...init.headers, "If-None-Match": unless304.tag }
      : init.headers;
    const response = await this._fetch(URLExt.join(this._base, path), {
      ...init,
      headers,
    });
    if (unless304 && response.status === 304) {
      return UNCHANGED;
    }
    if (!response.ok) {
      await this._fail(response);
    }
    const value = await this._json(response);
    unless304?.onTag(response.headers.get("ETag") ?? undefined);
    return value;
  }
}

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
  return jsonResponse(payload, {
    status: response.status,
    statusText: response.statusText,
  });
}

export function createSessionServerSettings(
  descriptor: ISessionAccess,
  options: { fetch?: typeof globalThis.fetch } = {},
): ServerConnection.ISettings {
  const access = validateSessionAccess(descriptor);
  const baseUrl = validDevTunnelRoot(access.jupyter.uri).origin + "/";
  const browserFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const invalidatingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    if (response.status === 401 || response.status === 403) {
      clearSessionAccess(access.sessionId);
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

function validateSessionValidation(value: unknown): ISessionValidation {
  if (
    !onlyKeys(value, [
      "sessionId",
      "status",
      "script",
      "message",
      "stdout",
      "stderr",
    ]) ||
    typeof value.sessionId !== "string" ||
    !VALIDATION_STATUSES.includes(value.status as SessionValidationStatus) ||
    typeof value.script !== "string" ||
    typeof value.message !== "string" ||
    (value.stdout !== undefined && typeof value.stdout !== "string") ||
    (value.stderr !== undefined && typeof value.stderr !== "string")
  ) {
    throw new Error("cs-control returned an invalid session validation.");
  }
  return value as ISessionValidation;
}

function validateLogLines(lines: unknown[]): ILogLine[] {
  let bytes = 0;
  const encoder = new TextEncoder();
  return lines.map((line): ILogLine => {
    if (
      !isPlainObject(line) ||
      !["status", "stdout", "stderr"].includes(String(line.stream)) ||
      typeof line.text !== "string" ||
      SESSION_LOG_CONTROL.test(line.text) ||
      typeof line.at !== "string" ||
      !exactKeys(line, ["stream", "text", "at"])
    ) {
      throw new Error("cs-control returned an invalid session log line.");
    }
    const size = encoder.encode(line.text).byteLength;
    bytes += size;
    if (size > 4096 || bytes > 64 * 1024) {
      throw new Error("cs-control returned an oversized session log event.");
    }
    return {
      stream: line.stream as LogStream,
      text: line.text,
      at: line.at,
    };
  });
}

function validateSessionLogTail(value: unknown): ISessionLogTail {
  if (
    !isPlainObject(value) ||
    typeof value.sessionId !== "string" ||
    !SESSION_ID.test(value.sessionId) ||
    !Array.isArray(value.lines) ||
    value.lines.length > 100 ||
    !exactKeys(value, ["sessionId", "lines"])
  ) {
    throw new Error("cs-control returned an invalid session log event.");
  }
  return { sessionId: value.sessionId, lines: validateLogLines(value.lines) };
}

function validateResources(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.cores === "number" &&
    typeof value.memoryMb === "number" &&
    typeof value.wallMinutes === "number"
  );
}

function validateGenerationAndJobSpec(value: Record<string, any>): boolean {
  return (
    typeof value.generation === "string" &&
    typeof value.sshHost === "string" &&
    typeof value.partition === "string" &&
    typeof value.rootFolder === "string" &&
    validateResources(value.resources)
  );
}

function validateSession(value: unknown): ISession {
  if (
    !onlyKeys(value, SESSION_KEYS) ||
    !SESSION_ID.test(String(value.id)) ||
    !validateGenerationAndJobSpec(value) ||
    !SESSION_STATES.includes(value.state as SessionState) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("cs-control returned an invalid session.");
  }
  return value as unknown as ISession;
}

function validateSample(value: unknown): IMetricSample {
  if (
    !isPlainObject(value) ||
    typeof value.at !== "string" ||
    (value.memBytes !== undefined && typeof value.memBytes !== "number") ||
    (value.cpuUsageUsec !== undefined &&
      typeof value.cpuUsageUsec !== "number") ||
    (value.gpus !== undefined &&
      (!Array.isArray(value.gpus) ||
        !value.gpus.every(
          (gpu) => isPlainObject(gpu) && typeof gpu.utilPct === "number",
        )))
  ) {
    throw new Error("cs-control returned an invalid metric sample.");
  }
  return value as unknown as IMetricSample;
}

function validateSessionSeries(value: unknown): ISessionSeries {
  if (
    !isPlainObject(value) ||
    !SESSION_ID.test(String(value.sessionId)) ||
    !(value.samples === undefined || Array.isArray(value.samples))
  ) {
    throw new Error("cs-control returned an invalid metric series.");
  }
  return {
    sessionId: value.sessionId as string,
    samples: ((value.samples ?? []) as unknown[]).map(validateSample),
  };
}

function validateRunStats(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    (value.requestedMemory === undefined ||
      typeof value.requestedMemory === "string") &&
    (value.elapsedSeconds === undefined ||
      typeof value.elapsedSeconds === "number") &&
    (value.maxRss === undefined || typeof value.maxRss === "string") &&
    (value.cpuEfficiencyPct === undefined ||
      typeof value.cpuEfficiencyPct === "number") &&
    (value.memoryEfficiencyPct === undefined ||
      typeof value.memoryEfficiencyPct === "number") &&
    (value.cores === undefined || typeof value.cores === "number")
  );
}

function validateRun(value: unknown): IRun {
  if (
    !isPlainObject(value) ||
    !SESSION_ID.test(String(value.sessionId)) ||
    !validateGenerationAndJobSpec(value) ||
    !SESSION_STATES.includes(value.finalState as SessionState) ||
    typeof value.endedAt !== "string" ||
    (value.stats !== undefined && !validateRunStats(value.stats)) ||
    (value.samples !== undefined && !Array.isArray(value.samples)) ||
    (value.logs !== undefined && !Array.isArray(value.logs))
  ) {
    throw new Error("cs-control returned an invalid run.");
  }
  return {
    ...(value as unknown as IRun),
    samples: value.samples && (value.samples as unknown[]).map(validateSample),
    logs: value.logs && validateLogLines(value.logs as unknown[]),
  };
}

function validateHost(value: unknown): ISshHost {
  if (
    !isPlainObject(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.extraDirectives) ||
    !value.extraDirectives.every(
      (directive) => typeof directive === "string",
    ) ||
    (value.hostname !== undefined && typeof value.hostname !== "string") ||
    (value.user !== undefined && typeof value.user !== "string") ||
    (value.port !== undefined && typeof value.port !== "number") ||
    (value.identityFile !== undefined &&
      typeof value.identityFile !== "string") ||
    (value.managed !== undefined && typeof value.managed !== "boolean")
  ) {
    throw new Error("cs-control returned an invalid SSH host.");
  }
  return value as unknown as ISshHost;
}

export function validateSlurmResource(value: unknown): ISlurmInfo {
  if (
    !isPlainObject(value) ||
    typeof value.host !== "string" ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every((account) => typeof account === "string") ||
    !Array.isArray(value.partitions) ||
    !value.partitions.every(
      (part) =>
        isPlainObject(part) &&
        typeof part.name === "string" &&
        typeof part.cpuCount === "number" &&
        typeof part.memoryMb === "number" &&
        Array.isArray(part.gres) &&
        part.gres.every(
          (gres: unknown) =>
            isPlainObject(gres) &&
            typeof gres.name === "string" &&
            typeof gres.count === "number",
        ),
    ) ||
    (value.homeDir !== undefined && typeof value.homeDir !== "string")
  ) {
    throw new Error("cs-control returned invalid Slurm discovery.");
  }
  return value as unknown as ISlurmInfo;
}
