// The typed client for cs-plane's REST and WebSocket API. Every response is
// validated against a Common.ts vObject shape covering every field cs-plane's
// response may carry, per docs/API.md in cs-plane, rejecting any other key;
// expect() turns a shape into a throwing parser for one call site. UNCHANGED
// marks a 304 Not Modified response, meaning the caller's cached copy is still
// current. accessUnavailable marks the 409 a session answers while leaving
// READY, which the next poll shows and no caller surfaces.
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import { Token } from "@lumino/coreutils";
import { AuthClient } from "./AuthClient";
import { OAuthWebSocketFactory, type OAuthWebSocketConnector } from "./ssh";
import {
  clearAllSessionAccess,
  clearSessionAccess,
  type ISessionAccess,
  validateSessionAccess,
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
  IHostHealth,
  ITokenProvider,
  SESSION_ID,
  SESSION_LAUNCHERS,
  SESSION_STATES,
  TOKEN_43,
  VALIDATION_STATUSES,
  expect,
  isPlainObject,
  jsonResponse,
  requestUrl,
  vArray,
  vBoolean,
  vBoundedInt,
  vEither,
  vNumber,
  vObject,
  vOneOf,
  vOptional,
  vPositiveInt,
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

export const UNCHANGED = Symbol("cs-plane session list unchanged");

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
    readonly status?: number,
  ) {
    super(message);
  }
}

const failsWith =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof ControlError && error.code === code;

export const needsSshLogin = failsWith("ssh_authentication_required");
export const accessUnavailable = failsWith("session_access_unavailable");

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const encoded = encodeURIComponent;

function owned<T>(value: T, id: string, expected: string, what: string): T {
  if (id !== expected) {
    throw new Error(`cs-plane returned ${what} for ${id}, not ${expected}.`);
  }
  return value;
}

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
    if (response.status === 401) {
      auth.invalidateToken?.();
    }
    return response;
  };
}

export const IControlClient = new Token<ControlClient>(
  "@cybershuttle/jupyter:IControlClient",
  "The shared cs-plane API client.",
);

export class ControlClient {
  private _base: string;
  private _fetch: typeof globalThis.fetch;
  private _webSockets: OAuthWebSocketFactory;
  private _auth: IControlAuth;
  private _sessionsTag: string | undefined;

  constructor(
    base = PageConfig.getOption("cybershuttleControlApiUrl"),
    auth?: IControlAuth,
    fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
    webSockets?: OAuthWebSocketFactory,
  ) {
    this._base = validControlApiUrl(base);
    this._auth = auth ?? new AuthClient(this._base);
    this._fetch = safeControlFetch(this._base, this._auth, fetch);
    this._webSockets =
      webSockets ??
      new OAuthWebSocketFactory(this._auth, new URL(this._base).origin);
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
    clearAllSessionAccess();
  }

  async listSshHosts(): Promise<ISshHost[]> {
    return validateHostList(await this._request("hosts")).hosts;
  }

  async addSshHost(
    name: string,
    command: string,
    keyId = "",
  ): Promise<ISshHost> {
    return validateHost(
      await this._request("hosts", json({ name, command, keyId })),
    );
  }

  async updateSshHost(
    alias: string,
    command: string,
    keyId = "",
  ): Promise<ISshHost> {
    return validateHost(
      await this._request(
        `hosts/${encoded(alias)}`,
        json({ command, keyId }, "PUT"),
      ),
    );
  }

  async listSshKeys(): Promise<ISshKey[]> {
    return validateKeyList(await this._request("keys/ssh")).keys;
  }

  async addSshKey(id: string, privateKey: string): Promise<ISshKey> {
    return validateKey(
      await this._request("keys/ssh", json({ id, privateKey })),
    );
  }

  async removeSshKey(id: string): Promise<void> {
    await this._request(`keys/ssh/${encoded(id)}`, { method: "DELETE" });
  }

  async removeSshHost(alias: string): Promise<void> {
    await this._request(`hosts/${encoded(alias)}`, { method: "DELETE" });
  }

  async hostHealth(alias: string): Promise<IHostHealth> {
    const value = validateHostHealth(
      await this._request(`hosts/${encoded(alias)}/health`),
    );
    return owned(value, value.host, alias, "a host health check");
  }

  async discoverSlurm(
    alias: string,
    signal?: AbortSignal,
  ): Promise<ISlurmInfo> {
    const value = validateSlurmResource(
      await this._request(`hosts/${encoded(alias)}/slurm`, { signal }),
    );
    return owned(value, value.host, alias, "Slurm discovery");
  }

  sshAuthWebSocket(alias: string): OAuthWebSocketConnector {
    const url = new URL(URLExt.join(this._base, `hosts/${encoded(alias)}/ssh`));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = url.toString();
    return () => this._webSockets.open(endpoint);
  }

  async getTunnelLink(): Promise<ITunnelLinkStatus> {
    return validateTunnelLinkStatus(await this._request("tunnel"));
  }

  async startTunnelLink(provider: TunnelProvider): Promise<ITunnelLinkStart> {
    return validateTunnelLinkStart(
      await this._request("tunnel/authorizations", json({ provider })),
    );
  }

  async pollTunnelLink(handle: string): Promise<ITunnelLinkPoll> {
    return validateTunnelLinkPoll(
      await this._request(`tunnel/authorizations/${encoded(handle)}/poll`, {
        method: "POST",
      }),
    );
  }

  async removeTunnelLink(): Promise<void> {
    await this._request("tunnel", { method: "DELETE" });
  }

  async listSessions(): Promise<ISessionList | typeof UNCHANGED> {
    const response = await this._send("sessions", {
      headers: this._sessionsTag ? { "If-None-Match": this._sessionsTag } : {},
    });
    if (response.status === 304) {
      return UNCHANGED;
    }
    const parsed = validateSessionList(await parseJson(response));
    for (const tail of parsed.logs ?? []) {
      checkLogBudget(tail.lines);
    }
    this._sessionsTag = response.headers.get("ETag") ?? undefined;
    return { sessions: parsed.sessions, logs: parsed.logs ?? [] };
  }

  async validateCreateRequest(
    request: ISessionCreateRequest,
    signal?: AbortSignal,
  ): Promise<ISessionValidation> {
    return validateSessionValidation(
      await this._request("sessions/validate", { ...json(request), signal }),
    );
  }

  async createSession(request: ISessionCreateRequest): Promise<ISession> {
    return validateSession(await this._request("sessions", json(request)));
  }

  getSession(id: string): Promise<ISession> {
    return this._sessionAt(id);
  }

  startSession(id: string): Promise<ISession> {
    return this._sessionAction(id, "start");
  }

  stopSession(id: string): Promise<ISession> {
    return this._sessionAction(id, "stop");
  }

  async deleteSession(id: string): Promise<void> {
    const sessionId = validSessionId(id);
    await this._request(`sessions/${encoded(sessionId)}`, { method: "DELETE" });
    clearSessionAccess(sessionId);
  }

  async getSessionMetrics(id: string): Promise<ISessionSeries> {
    const sessionId = validSessionId(id);
    const series = validateSessionSeries(
      await this._request(`sessions/${encoded(sessionId)}/metrics`),
    );
    return owned(series, series.sessionId, sessionId, "metrics");
  }

  async listRuns(): Promise<IRun[]> {
    const runs = validateRunList(await this._request("telemetry")).runs;
    for (const run of runs) {
      checkLogBudget(run.logs ?? []);
    }
    return runs;
  }

  async getSessionAccess(id: string): Promise<ISessionAccess> {
    const sessionId = validSessionId(id);
    const access = validateSessionAccess(
      await this._request(`sessions/${encoded(sessionId)}/access`),
    );
    if (
      access.jupyter.uri !==
      URLExt.join(this._base, `sessions/${encoded(sessionId)}/jupyter/`)
    ) {
      throw new Error("cs-plane named a Jupyter proxy outside its own API.");
    }
    return owned(access, access.sessionId, sessionId, "access");
  }

  private async _sessionAction(id: string, verb: string): Promise<ISession> {
    const session = await this._sessionAt(id, `/${verb}`, { method: "POST" });
    clearSessionAccess(session.id);
    return session;
  }

  private async _sessionAt(
    id: string,
    suffix = "",
    init?: RequestInit,
  ): Promise<ISession> {
    const sessionId = validSessionId(id);
    const session = validateSession(
      await this._request(`sessions/${encoded(sessionId)}${suffix}`, init),
    );
    return owned(session, session.id, sessionId, "a session");
  }

  private async _send(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this._fetch(URLExt.join(this._base, path), init);
    if (!response.ok && response.status !== 304) {
      let message = `cs-plane returned ${response.status}`;
      let code = "request_failed";
      try {
        const value = await response.json();
        if (isPlainObject(value) && isPlainObject(value.error)) {
          if (typeof value.error.code === "string") code = value.error.code;
          if (typeof value.error.message === "string") {
            message = value.error.message;
          }
        }
      } catch {}
      throw new ControlError(code, message, response.status);
    }
    return response;
  }

  private async _request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this._send(path, init);
    return response.status === 204 ? undefined : parseJson(response);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("cs-plane returned invalid JSON.");
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
  const baseUrl = access.jupyter.uri;
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
    wsUrl: baseUrl.replace(/^http/, "ws"),
  });
}

function checkLogBudget(lines: ILogLine[]): void {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const line of lines) {
    if (SESSION_LOG_CONTROL.test(line.text)) {
      throw new Error("cs-plane returned an invalid session log line.");
    }
    const size = encoder.encode(line.text).byteLength;
    bytes += size;
    if (size > 4096 || bytes > 64 * 1024) {
      throw new Error("cs-plane returned an oversized session log event.");
    }
  }
}

const validateSessionValidation = expect(
  vObject<ISessionValidation>({
    sessionId: vString(),
    status: vOneOf(VALIDATION_STATUSES),
    script: vString(),
    message: vString(),
    stdout: vOptional(vString()),
    stderr: vOptional(vString()),
  }),
  "session validation",
);

const logLineShape = vObject<ILogLine>({
  stream: vOneOf(["status", "stdout", "stderr"] as const),
  text: vString(),
  at: vString(),
});

const sessionLogTailShape = vObject<ISessionLogTail>({
  sessionId: vString(SESSION_ID),
  lines: vArray(logLineShape, 100),
});

const jobSpecFields = {
  sshHost: vString(),
  account: vOptional(vString()),
  partition: vString(),
  rootFolder: vString(),
  resources: vObject<ISession["resources"]>({
    cores: vBoundedInt(2, Number.MAX_SAFE_INTEGER),
    memoryMb: vBoundedInt(4096, Number.MAX_SAFE_INTEGER),
    wallMinutes: vBoundedInt(1, 525600),
    gpuType: vOptional(vString()),
    gpuCount: vOptional(vPositiveInt),
  }),
};

const sessionShape = vObject<ISession>({
  id: vString(SESSION_ID),
  ...jobSpecFields,
  seq: vBoundedInt(0, Number.MAX_SAFE_INTEGER),
  state: vOneOf(SESSION_STATES),
  launcher: vOneOf(SESSION_LAUNCHERS),
  error: vOptional(vString()),
  createdAt: vString(),
  startedAt: vOptional(vString()),
  updatedAt: vString(),
});
const validateSession = expect(sessionShape, "session");

const validateSessionList = expect(
  vObject<{ sessions: ISession[]; logs?: ISessionLogTail[] }>({
    sessions: vArray(sessionShape),
    logs: vOptional(vArray(sessionLogTailShape)),
  }),
  "session list",
);

const sampleShape = vObject<IMetricSample>({
  at: vString(),
  memBytes: vOptional(vNumber),
  cpuUsageUsec: vOptional(vNumber),
  gpus: vOptional(
    vArray(
      vObject<NonNullable<IMetricSample["gpus"]>[number]>({
        index: vNumber,
        utilPct: vOptional(vNumber),
        memUsedMiB: vOptional(vNumber),
        memTotalMiB: vOptional(vNumber),
      }),
    ),
  ),
});

const validateSessionSeries = expect(
  vObject<ISessionSeries>({
    sessionId: vString(SESSION_ID),
    samples: vArray(sampleShape),
  }),
  "metric series",
);

const validateRunList = expect(
  vObject<{ runs: IRun[] }>({
    runs: vArray(
      vObject<IRun>({
        sessionId: vString(SESSION_ID),
        ...jobSpecFields,
        seq: vPositiveInt,
        finalState: vOneOf(SESSION_STATES),
        error: vOptional(vString()),
        startedAt: vOptional(vString()),
        endedAt: vString(),
        stats: vOptional(
          vObject<IRunStats>({
            requestedMemory: vOptional(vString()),
            elapsedSeconds: vOptional(vNumber),
            maxRss: vOptional(vString()),
            cpuEfficiencyPct: vOptional(vNumber),
            memoryEfficiencyPct: vOptional(vNumber),
            cores: vOptional(vNumber),
          }),
        ),
        samples: vOptional(vArray(sampleShape)),
        logs: vOptional(vArray(logLineShape)),
      }),
    ),
  }),
  "run history",
);

const hostShape = vObject<ISshHost>({
  name: vString(),
  hostname: vOptional(vString()),
  user: vOptional(vString()),
  port: vOptional(vNumber),
  keyId: vOptional(vString()),
  extraDirectives: vArray(vString()),
  managed: vOptional(vBoolean),
});
const validateHost = expect(hostShape, "SSH host");
const validateHostList = expect(
  vObject<{ hosts: ISshHost[] }>({ hosts: vArray(hostShape) }),
  "SSH host list",
);

const keyShape = vObject<ISshKey>({
  id: vString(),
  type: vString(),
  fingerprint: vString(),
});
const validateKey = expect(keyShape, "SSH key");
const validateKeyList = expect(
  vObject<{ keys: ISshKey[] }>({ keys: vArray(keyShape) }),
  "SSH key list",
);

const validateHostHealth = expect(
  vObject<IHostHealth>({ host: vString(), ok: vBoolean, message: vString() }),
  "host health",
);

export const validateSlurmResource = expect(
  vObject<ISlurmInfo>({
    host: vString(),
    accounts: vArray(vString()),
    partitions: vArray(
      vObject<IPartition>({
        name: vString(),
        cpuCount: vNumber,
        memoryMb: vNumber,
        gres: vArray(vObject<IGres>({ name: vString(), count: vNumber })),
      }),
    ),
    homeDir: vOptional(vString()),
  }),
  "Slurm discovery",
);

export type ITunnelLinkStatus =
  | {
      linked: true;
      provider: TunnelProvider;
      account?: string;
      linkedAt: string;
    }
  | { linked: false };

interface ITunnelLinkStart {
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

type ITunnelLinkPoll =
  | { status: "pending"; intervalSeconds: number; linked: false }
  | ({ status: "linked" } & Extract<ITunnelLinkStatus, { linked: true }>);

const tunnelLinkedFields = {
  linked: vOneOf([true] as const),
  provider: vOneOf(["microsoft", "github"] as const),
  account: vOptional(vString()),
  linkedAt: vString(),
};

const validateTunnelLinkStatus = expect(
  vEither<ITunnelLinkStatus>(
    vObject<Extract<ITunnelLinkStatus, { linked: true }>>(tunnelLinkedFields),
    vObject<Extract<ITunnelLinkStatus, { linked: false }>>({
      linked: vOneOf([false] as const),
    }),
  ),
  "Dev Tunnels link",
);

const validateTunnelLinkStart = expect(
  vObject<ITunnelLinkStart>({
    handle: vString(TOKEN_43),
    userCode: vString(),
    verificationUri: vString(),
    expiresInSeconds: vBoundedInt(1, 3600),
    intervalSeconds: vBoundedInt(1, 60),
  }),
  "Dev Tunnels link start",
);

const validateTunnelLinkPoll = expect(
  vEither<ITunnelLinkPoll>(
    vObject<Extract<ITunnelLinkPoll, { status: "pending" }>>({
      status: vOneOf(["pending"] as const),
      intervalSeconds: vBoundedInt(1, 60),
      linked: vOneOf([false] as const),
    }),
    vObject<Extract<ITunnelLinkPoll, { status: "linked" }>>({
      status: vOneOf(["linked"] as const),
      ...tunnelLinkedFields,
    }),
  ),
  "Dev Tunnels link poll",
);
