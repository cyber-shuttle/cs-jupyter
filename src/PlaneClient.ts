// The typed client for cs-plane's REST and WebSocket API. Every response is
// validated against a Common.ts vObject shape covering every field cs-plane's
// response may carry, per docs/API.md in cs-plane, ignoring unlisted keys;
// grant and token shapes are strict; expect() turns a shape into a throwing
// parser for one call site. UNCHANGED marks a 304 Not Modified response,
// meaning the caller's cached copy is still current. accessUnavailable marks
// the 409 a session answers while leaving READY, which the next poll shows and
// no caller surfaces.
import { PageConfig, URLExt } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import { Token } from "@lumino/coreutils";
import type * as plane from "./api/session";
import type * as devtunnels from "./api/devtunnels";
import { AuthClient } from "./AuthClient";
import { OAuthWebSocketFactory, type OAuthWebSocketConnector } from "./ssh";
import {
  IGres,
  ILogLine,
  IUsageSample,
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
  ISshHostHealth,
  ITokenProvider,
  DEVTUNNELS_PROVIDERS,
  SESSION_ID,
  PLATFORMS,
  SESSION_STATES,
  TOKEN_43,
  TRANSPORTS,
  VALIDATION_STATUSES,
  expect,
  failsWith,
  isPlainObject,
  jsonResponse,
  parseJson,
  planeError,
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
  validPlaneApiUrl,
  validSessionId,
  type DevTunnelsProvider,
  type Narrow,
} from "./Common";

const SESSION_LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type ISessionLogTail = Narrow<
  plane.SessionLogTail,
  { lines: ILogLine[] }
>;

export type ISessionAccess = plane.SessionAccessResponse;

export const UNCHANGED = Symbol("cs-plane session list unchanged");

export type ISessionList = Narrow<
  plane.SessionList,
  { sessions: ISession[]; logs: ISessionLogTail[] }
>;

export interface IPlaneAuth extends ITokenProvider {
  signIn(): Promise<void>;
  readonly identity?: string | undefined;
}

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

export function safePlaneFetch(
  planeApiUrl: string,
  auth: ITokenProvider,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  const planeOrigin = new URL(planeApiUrl).origin;
  return async (input, init = {}) => {
    const url = new URL(requestUrl(input));
    if (url.origin !== planeOrigin) {
      throw new Error(
        "Blocked a request outside the configured cs-plane origin.",
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

export const IPlaneClient = new Token<PlaneClient>(
  "@cybershuttle/jupyter:IPlaneClient",
  "The shared cs-plane API client.",
);

export class PlaneClient {
  private _base: string;
  private _fetch: typeof globalThis.fetch;
  private _webSockets: OAuthWebSocketFactory;
  private _auth: IPlaneAuth;
  private _sessionsTag: string | undefined;

  constructor(
    base = PageConfig.getOption("cybershuttlePlaneApiUrl"),
    auth?: IPlaneAuth,
    fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
    webSockets?: OAuthWebSocketFactory,
  ) {
    this._base = validPlaneApiUrl(base);
    this._auth = auth ?? new AuthClient(this._base);
    this._fetch = safePlaneFetch(this._base, this._auth, fetch);
    this._webSockets =
      webSockets ??
      new OAuthWebSocketFactory(this._auth, new URL(this._base).origin);
  }

  async signIn(): Promise<void> {
    this._sessionsTag = undefined;
    await this._auth.signIn();
  }

  async resumeSignIn(): Promise<void> {
    this._sessionsTag = undefined;
    await this._auth.acquireToken();
  }

  get identity(): string | undefined {
    return this._auth.identity;
  }

  signOut(): void {
    this._sessionsTag = undefined;
    this._auth.invalidateToken?.();
  }

  async listSshHosts(): Promise<ISshHost[]> {
    return validateHostList(await this._request("hosts")).hosts;
  }

  async addSshHost(
    alias: string,
    command: string,
    keyId = "",
  ): Promise<ISshHost> {
    return validateHost(
      await this._request("hosts", json({ alias, command, keyId })),
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

  async deleteSshKey(id: string): Promise<void> {
    await this._request(`keys/ssh/${encoded(id)}`, { method: "DELETE" });
  }

  async deleteSshHost(alias: string): Promise<void> {
    await this._request(`hosts/${encoded(alias)}`, { method: "DELETE" });
  }

  async sshHostHealth(alias: string): Promise<ISshHostHealth> {
    const value = validateSshHostHealth(
      await this._request(`hosts/${encoded(alias)}/health`),
    );
    return owned(value, value.alias, alias, "an SSH host health check");
  }

  async discoverSlurm(
    alias: string,
    signal?: AbortSignal,
  ): Promise<ISlurmInfo> {
    const value = validateSlurmResource(
      await this._request(`hosts/${encoded(alias)}/slurm`, { signal }),
    );
    return owned(value, value.alias, alias, "Slurm discovery");
  }

  sshAuthWebSocket(alias: string): OAuthWebSocketConnector {
    const url = new URL(URLExt.join(this._base, `hosts/${encoded(alias)}/ssh`));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const endpoint = url.toString();
    return () => this._webSockets.open(endpoint);
  }

  async getDevTunnelsAccount(): Promise<IDevTunnelsAccountStatus> {
    return validateDevTunnelsAccountStatus(await this._request("devtunnels"));
  }

  async connectDevTunnelsAccount(
    provider: DevTunnelsProvider,
  ): Promise<devtunnels.AuthorizationStart> {
    return validateDevTunnelsAccountStart(
      await this._request("devtunnels/authorizations", json({ provider })),
    );
  }

  async pollDevTunnelsAccount(handle: string): Promise<IDevTunnelsAccountPoll> {
    return validateDevTunnelsAccountPoll(
      await this._request(`devtunnels/authorizations/${encoded(handle)}/poll`, {
        method: "POST",
      }),
    );
  }

  async disconnectDevTunnelsAccount(): Promise<void> {
    await this._request("devtunnels", { method: "DELETE" });
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
    return this._sessionAt(id, "/start", { method: "POST" });
  }

  stopSession(id: string): Promise<ISession> {
    return this._sessionAt(id, "/stop", { method: "POST" });
  }

  async deleteSession(id: string): Promise<void> {
    await this._request(`sessions/${encoded(validSessionId(id))}`, {
      method: "DELETE",
    });
  }

  async getSessionUsage(id: string): Promise<ISessionSeries> {
    const sessionId = validSessionId(id);
    const series = validateSessionSeries(
      await this._request(`sessions/${encoded(sessionId)}/usage`),
    );
    return owned(series, series.sessionId, sessionId, "usage");
  }

  async listRuns(): Promise<IRun[]> {
    const runs = validateRunList(await this._request("runs")).runs;
    for (const run of runs) {
      checkLogBudget(run.logs ?? []);
    }
    return runs;
  }

  async getSessionAccess(id: string): Promise<ISessionAccess> {
    const sessionId = validSessionId(id);
    const access = await this._request(`sessions/${encoded(sessionId)}/access`);
    if (!accessShape(access) || !(Date.parse(access.expiresAt) > Date.now())) {
      throw new Error("Session access is invalid or expired.");
    }
    if (
      access.jupyter.uri !==
      URLExt.join(this._base, `sessions/${encoded(sessionId)}/jupyter/`)
    ) {
      throw new Error("cs-plane named a Jupyter proxy outside its own API.");
    }
    return owned(access, access.sessionId, sessionId, "access");
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
      throw await planeError(response);
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

const JUPYTER_RELOAD_KEY = "cybershuttle.jupyter-reload.v1";

export function createSessionServerSettings(
  access: ISessionAccess,
  {
    fetch: browserFetch = globalThis.fetch.bind(globalThis),
    reload = () => window.location.reload(),
  }: { fetch?: typeof globalThis.fetch; reload?: () => void } = {},
): ServerConnection.ISettings {
  const baseUrl = access.jupyter.uri;
  const run = `${access.sessionId}/${access.seq}`;
  const reloadingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    if (response.status === 401 || response.status === 403) {
      if (sessionStorage.getItem(JUPYTER_RELOAD_KEY) === run) {
        return jsonResponse(
          {
            message:
              "Jupyter refused this session's access again; reopen the session from the Launcher.",
          },
          { status: response.status },
        );
      }
      sessionStorage.setItem(JUPYTER_RELOAD_KEY, run);
      reload();
      return response;
    }
    if (response.ok) sessionStorage.removeItem(JUPYTER_RELOAD_KEY);
    if (response.ok && requestUrl(input).includes("/api/kernelspecs")) {
      return withoutUnreachableKernelSpecLogos(response);
    }
    return response;
  };
  return ServerConnection.makeSettings({
    appendToken: true,
    baseUrl,
    fetch: reloadingFetch,
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

const accessShape = vObject<ISessionAccess>(
  {
    sessionId: vString(SESSION_ID),
    seq: vPositiveInt,
    expiresAt: vString(),
    jupyter: vObject({ uri: vString(), token: vString(TOKEN_43) }, true),
  },
  true,
);

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
  alias: vString(),
  account: vOptional(vString()),
  partition: vString(),
  rootFolder: vString(),
  resources: vObject<ISession["resources"]>({
    cores: vPositiveInt,
    memoryMb: vPositiveInt,
    wallMinutes: vPositiveInt,
    gpuType: vOptional(vString()),
    gpuCount: vOptional(vPositiveInt),
  }),
  tunnelModes: (v: unknown): v is ISession["tunnelModes"] =>
    vArray(vOneOf(TRANSPORTS))(v) && v.length > 0,
};

const sessionShape = vObject<ISession>({
  id: vString(SESSION_ID),
  ...jobSpecFields,
  seq: vBoundedInt(0, Number.MAX_SAFE_INTEGER),
  state: vOneOf(SESSION_STATES),
  platform: vOneOf(PLATFORMS),
  error: vOptional(vString()),
  createdAt: vString(),
  startedAt: vOptional(vString()),
  updatedAt: vString(),
});
const validateSession = expect(sessionShape, "session");

const validateSessionList = expect(
  vObject<ISessionList>({
    sessions: vArray(sessionShape),
    logs: vArray(sessionLogTailShape),
  }),
  "session list",
);

const sampleShape = vObject<IUsageSample>({
  at: vString(),
  memBytes: vOptional(vNumber),
  cpuUsageUsec: vOptional(vNumber),
  gpus: vOptional(
    vArray(
      vObject<NonNullable<IUsageSample["gpus"]>[number]>({
        index: vNumber,
        utilPct: vNumber,
        memUsedMiB: vNumber,
        memTotalMiB: vNumber,
      }),
    ),
  ),
});

const validateSessionSeries = expect(
  vObject<ISessionSeries>({
    sessionId: vString(SESSION_ID),
    samples: vArray(sampleShape),
  }),
  "usage series",
);

const validateRunList = expect(
  vObject<{ runs: IRun[] }>({
    runs: vArray(
      vObject<IRun>({
        sessionId: vString(SESSION_ID),
        ...jobSpecFields,
        seq: vPositiveInt,
        platform: vOptional(vOneOf(PLATFORMS)),
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
  alias: vString(),
  hostname: vOptional(vString()),
  user: vOptional(vString()),
  port: vOptional(vNumber),
  keyId: vOptional(vString()),
  extraDirectives: vArray(vString()),
  managed: vBoolean,
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

const validateSshHostHealth = expect(
  vObject<ISshHostHealth>({
    alias: vString(),
    ok: vBoolean,
    message: vString(),
  }),
  "SSH host health",
);

export const validateSlurmResource = expect(
  vObject<ISlurmInfo>({
    alias: vString(),
    accounts: vArray(vString()),
    partitions: vArray(
      vObject<IPartition>({
        name: vString(),
        cpuCount: vNumber,
        memoryMb: vNumber,
        gres: vArray(vObject<IGres>({ name: vString(), count: vNumber })),
      }),
    ),
    homeDir: vString(),
  }),
  "Slurm discovery",
);

export type IDevTunnelsAccountStatus =
  | {
      connected: true;
      provider: DevTunnelsProvider;
      account?: string;
      connectedAt: string;
    }
  | { connected: false };

type IDevTunnelsAccountPoll =
  | { status: "pending"; intervalSeconds: number; connected: false }
  | ({ status: "connected" } & Extract<
      IDevTunnelsAccountStatus,
      { connected: true }
    >);

const connectedFields = {
  connected: vOneOf([true] as const),
  provider: vOneOf(DEVTUNNELS_PROVIDERS),
  account: vOptional(vString()),
  connectedAt: vString(),
};

const validateDevTunnelsAccountStatus = expect(
  vEither<IDevTunnelsAccountStatus>(
    vObject<Extract<IDevTunnelsAccountStatus, { connected: true }>>(
      connectedFields,
    ),
    vObject<Extract<IDevTunnelsAccountStatus, { connected: false }>>({
      connected: vOneOf([false] as const),
    }),
  ),
  "Dev Tunnels account",
);

const validateDevTunnelsAccountStart = expect(
  vObject<devtunnels.AuthorizationStart>({
    handle: vString(TOKEN_43),
    userCode: vString(),
    verificationUri: vString(),
    expiresInSeconds: vBoundedInt(1, 3600),
    intervalSeconds: vBoundedInt(1, 60),
  }),
  "Dev Tunnels device code",
);

const validateDevTunnelsAccountPoll = expect(
  vEither<IDevTunnelsAccountPoll>(
    vObject<Extract<IDevTunnelsAccountPoll, { status: "pending" }>>({
      status: vOneOf(["pending"] as const),
      intervalSeconds: vBoundedInt(1, 60),
      connected: vOneOf([false] as const),
    }),
    vObject<Extract<IDevTunnelsAccountPoll, { status: "connected" }>>({
      status: vOneOf(["connected"] as const),
      ...connectedFields,
    }),
  ),
  "Dev Tunnels account poll",
);
