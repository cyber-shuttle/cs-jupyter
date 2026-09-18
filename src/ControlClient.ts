// The typed client for cs-control's REST and WebSocket API. Every response is
// validated against a Common.ts vObject shape covering every field cs-control's
// response may carry, per docs/API.md in cs-control, rejecting any other key;
// expect() turns a shape into a throwing parser for one call site. UNCHANGED
// marks a 304 Not Modified response, meaning the caller's cached copy is still
// current. accessUnavailable marks the 409 a session answers while leaving
// READY, which the next poll shows and no caller surfaces.
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import { AuthClient } from "./AuthClient";
import { OAuthWebSocketFactory, type OAuthWebSocketConnector } from "./ssh";
import {
  clearSessionAccess,
  type ISessionAccess,
  validateSessionAccess,
  validDevTunnelRoot,
} from "./session";
import {
  IGres,
  ILogLine,
  IMetricSample,
  IPartition,
  IRun,
  IRunStats,
  ISession,
  ISessionCreateRequest,
  ISessionSeries,
  ISessionValidation,
  ISlurmInfo,
  ISshHost,
  ISshKey,
  ISshHostTest,
  ITokenProvider,
  SESSION_ID,
  SESSION_STATES,
  TOKEN_43,
  VALIDATION_STATUSES,
  expect,
  isPlainObject,
  jsonResponse,
  isPositiveInteger,
  requestUrl,
  vArray,
  vBoolean,
  vBoundedInt,
  vNumber,
  vObject,
  vOneOf,
  vOptional,
  vString,
  validControlApiUrl,
  validSessionId,
  type TunnelProvider,
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
  interactiveLogin(): Promise<void>;
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

export const needsTunnelLink = (error: unknown): boolean =>
  error instanceof ControlError && error.code === "tunnel_link_required";

export const accessUnavailable = (error: unknown): boolean =>
  error instanceof ControlError && error.code === "session_access_unavailable";

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
    headers.set("Authorization", `Bearer ${credentials.idToken}`);
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
    return expect(sshHostListShape, "SSH host list")(await this._request("ssh"))
      .hosts;
  }

  async addSshHost(name: string, command: string, key = ""): Promise<ISshHost> {
    return validateHost(
      await this._request("ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, command, key }),
      }),
    );
  }

  async updateSshHost(
    alias: string,
    command: string,
    key = "",
  ): Promise<ISshHost> {
    return validateHost(
      await this._request(`ssh/${encodeURIComponent(alias)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, key }),
      }),
    );
  }

  async listSshKeys(): Promise<ISshKey[]> {
    return expect(sshKeyListShape, "SSH key list")(await this._request("keys"))
      .keys;
  }

  async addSshKey(name: string, privateKey: string): Promise<ISshKey> {
    return expect(
      sshKeyShape,
      "SSH key",
    )(
      await this._request("keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, privateKey }),
      }),
    );
  }

  async removeSshKey(name: string): Promise<void> {
    await this._request(`keys/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async removeSshHost(alias: string): Promise<void> {
    await this._request(`ssh/${encodeURIComponent(alias)}`, {
      method: "DELETE",
    });
  }

  async testSshHost(alias: string): Promise<ISshHostTest> {
    const value = expect(
      sshHostTestShape,
      "SSH host test",
    )(
      await this._request(`ssh/${encodeURIComponent(alias)}/test`, {
        method: "POST",
      }),
    );
    if (value.host !== alias) {
      throw new Error(
        `Received an SSH host test for ${value.host}, not ${alias}.`,
      );
    }
    return value;
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

  async getTunnelLink(): Promise<ITunnelLinkStatus> {
    return validateTunnelLinkStatus(await this._request("tunnel/link"));
  }

  async startTunnelLink(provider: TunnelProvider): Promise<ITunnelLinkStart> {
    return validateTunnelLinkStart(
      await this._request("tunnel/link/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      }),
    );
  }

  async pollTunnelLink(handle: string): Promise<ITunnelLinkPoll> {
    return validateTunnelLinkPoll(
      await this._request(`tunnel/link/poll/${encodeURIComponent(handle)}`, {
        method: "POST",
      }),
    );
  }

  async removeTunnelLink(): Promise<ITunnelLinkStatus> {
    return validateTunnelLinkStatus(
      await this._request("tunnel/link", { method: "DELETE" }),
    );
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
    const parsed = expect(sessionListShape, "session list")(value);
    for (const tail of parsed.logs ?? []) {
      checkLogBudget(tail.lines);
    }
    this._sessionsTag = tag;
    return { sessions: parsed.sessions, logs: parsed.logs ?? [] };
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
    const { runs } = expect(
      runListShape,
      "run history",
    )(await this._request("sessions/history"));
    for (const run of runs) {
      if (run.logs) {
        checkLogBudget(run.logs);
      }
    }
    return runs;
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

const sessionValidationShape = vObject<ISessionValidation>({
  sessionId: vString(),
  status: vOneOf(VALIDATION_STATUSES),
  script: vString(),
  message: vString(),
  stdout: vOptional(vString()),
  stderr: vOptional(vString()),
});
const validateSessionValidation = expect(
  sessionValidationShape,
  "session validation",
);

const logLineShape = vObject<ILogLine>({
  stream: vOneOf(["status", "stdout", "stderr"] as const),
  text: vString(),
  at: vString(),
});

function checkLogBudget(lines: ILogLine[]): ILogLine[] {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const line of lines) {
    if (SESSION_LOG_CONTROL.test(line.text)) {
      throw new Error("cs-control returned an invalid session log line.");
    }
    const size = encoder.encode(line.text).byteLength;
    bytes += size;
    if (size > 4096 || bytes > 64 * 1024) {
      throw new Error("cs-control returned an oversized session log event.");
    }
  }
  return lines;
}

const sessionLogTailShape = vObject<ISessionLogTail>({
  sessionId: vString(SESSION_ID),
  lines: vArray(logLineShape, 100),
});

const resourcesShape = vObject<ISession["resources"]>({
  cores: vNumber,
  memoryMb: vNumber,
  wallMinutes: vNumber,
  gpuType: vOptional(vString()),
  gpuCount: vOptional(vNumber),
});

const seqAndJobSpecFields = {
  seq: isPositiveInteger,
  sshHost: vString(),
  account: vOptional(vString()),
  partition: vString(),
  rootFolder: vString(),
  resources: resourcesShape,
};

const sessionShape = vObject<ISession>({
  id: vString(SESSION_ID),
  ...seqAndJobSpecFields,
  state: vOneOf(SESSION_STATES),
  error: vOptional(vString()),
  createdAt: vString(),
  startedAt: vOptional(vString()),
  updatedAt: vString(),
});
const validateSession = expect(sessionShape, "session");

const gpuUtilisationShape = vObject<NonNullable<IMetricSample["gpus"]>[number]>(
  {
    index: vNumber,
    utilPct: vOptional(vNumber),
    memUsedMiB: vOptional(vNumber),
    memTotalMiB: vOptional(vNumber),
  },
);

const sampleShape = vObject<IMetricSample>({
  at: vString(),
  memBytes: vOptional(vNumber),
  cpuUsageUsec: vOptional(vNumber),
  gpus: vOptional(vArray(gpuUtilisationShape)),
});

const sessionSeriesShape = vObject<ISessionSeries>({
  sessionId: vString(SESSION_ID),
  samples: vArray(sampleShape),
});
const validateSessionSeries = expect(sessionSeriesShape, "metric series");

const runStatsShape = vObject<IRunStats>({
  requestedMemory: vOptional(vString()),
  elapsedSeconds: vOptional(vNumber),
  maxRss: vOptional(vString()),
  cpuEfficiencyPct: vOptional(vNumber),
  memoryEfficiencyPct: vOptional(vNumber),
  cores: vOptional(vNumber),
});

const runShape = vObject<IRun>({
  sessionId: vString(SESSION_ID),
  ...seqAndJobSpecFields,
  finalState: vOneOf(SESSION_STATES),
  error: vOptional(vString()),
  startedAt: vOptional(vString()),
  endedAt: vString(),
  stats: vOptional(runStatsShape),
  samples: vOptional(vArray(sampleShape)),
  logs: vOptional(vArray(logLineShape)),
});

const hostShape = vObject<ISshHost>({
  name: vString(),
  hostname: vOptional(vString()),
  user: vOptional(vString()),
  port: vOptional(vNumber),
  identityFile: vOptional(vString()),
  key: vOptional(vString()),
  extraDirectives: vArray(vString()),
  managed: vOptional(vBoolean),
});
const validateHost = expect(hostShape, "SSH host");

const sshKeyShape = vObject<ISshKey>({
  name: vString(),
  type: vString(),
  fingerprint: vString(),
});

const sshKeyListShape = vObject<{ keys: ISshKey[] }>({
  keys: vArray(sshKeyShape),
});

const sshHostTestShape = vObject<ISshHostTest>({
  host: vString(),
  ok: vBoolean,
  message: vString(),
});

const sshHostListShape = vObject<{ hosts: ISshHost[] }>({
  hosts: vArray(hostShape),
});

const gresShape = vObject<IGres>({ name: vString(), count: vNumber });

const partitionShape = vObject<IPartition>({
  name: vString(),
  cpuCount: vNumber,
  memoryMb: vNumber,
  gres: vArray(gresShape),
});

const slurmShape = vObject<ISlurmInfo>({
  host: vString(),
  accounts: vArray(vString()),
  partitions: vArray(partitionShape),
  homeDir: vOptional(vString()),
});

export const validateSlurmResource = expect(slurmShape, "Slurm discovery");

export type ITunnelLinkStatus =
  | {
      linked: true;
      provider: TunnelProvider;
      account?: string;
      linkedAt: string;
    }
  | { linked: false };

export interface ITunnelLinkStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type ITunnelLinkPoll =
  | { status: "pending"; intervalSeconds: number }
  | ITunnelLinkStatus;

const tunnelLinkedShape = vObject<Extract<ITunnelLinkStatus, { linked: true }>>(
  {
    linked: (v): v is true => v === true,
    provider: vOneOf(["microsoft", "github"] as const),
    account: vOptional(vString()),
    linkedAt: vString(),
  },
);
const tunnelUnlinkedShape = vObject<
  Extract<ITunnelLinkStatus, { linked: false }>
>({ linked: (v): v is false => v === false });
function isTunnelLinkStatus(value: unknown): value is ITunnelLinkStatus {
  return tunnelLinkedShape(value) || tunnelUnlinkedShape(value);
}
const validateTunnelLinkStatus = expect(isTunnelLinkStatus, "Dev Tunnels link");

const tunnelLinkStartShape = vObject<ITunnelLinkStart>({
  handle: vString(TOKEN_43),
  userCode: vString(),
  verificationUri: vString(),
  expiresInSeconds: vBoundedInt(1, 3600),
  intervalSeconds: vBoundedInt(1, 60),
});
const validateTunnelLinkStart = expect(
  tunnelLinkStartShape,
  "Dev Tunnels link start",
);

const tunnelLinkPendingShape = vObject<
  Extract<ITunnelLinkPoll, { status: "pending" }>
>({
  status: vOneOf(["pending"] as const),
  intervalSeconds: vBoundedInt(1, 60),
});
function isTunnelLinkPoll(value: unknown): value is ITunnelLinkPoll {
  return tunnelLinkPendingShape(value) || isTunnelLinkStatus(value);
}
const validateTunnelLinkPoll = expect(
  isTunnelLinkPoll,
  "Dev Tunnels link poll",
);

const sessionListShape = vObject<{
  sessions: ISession[];
  logs?: ISessionLogTail[];
}>({
  sessions: vArray(sessionShape),
  logs: vOptional(vArray(sessionLogTailShape)),
});

const runListShape = vObject<{ runs: IRun[] }>({ runs: vArray(runShape) });
