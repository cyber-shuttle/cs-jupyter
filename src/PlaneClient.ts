// The typed client for the CyberShuttle API. A session is one BATCH_JOB process
// and its id is the process id; ended processes are runs. accessUnavailable
// marks the 409 an access read answers before the job's link is up, which the
// next poll retries and no caller surfaces.
import { PageConfig } from "@jupyterlab/coreutils";
import { ServerConnection } from "@jupyterlab/services";
import { Token } from "@lumino/coreutils";
import { AuthClient } from "./AuthClient";
import {
  IDeployment,
  IGres,
  ILogLine,
  IPlaneAuth,
  IUsageReport,
  ISession,
  ISlurmInfo,
  PlaneError,
  isEnded,
  isPlainObject,
  jsonResponse,
  planeApi,
  planeError,
  requestUrl,
  unwrap,
  validPlaneApiUrl,
  type PlaneApi,
  type Schemas,
} from "./Common";

export type ISessionLogTail = { sessionId: string; lines: ILogLine[] };

export type ISessionAccess = Schemas["AccessResponse"];

export interface ISessionList {
  sessions: ISession[];
  runs: ISession[];
}

const by = (processId: string) => ({ params: { path: { processId } } });

export const accessUnavailable = (error: unknown): boolean =>
  error instanceof PlaneError && error.status === 409;

// This tab's connection, kept across reloads: SSH logins it starts prompt only here.
const CONNECTION_KEY = "cybershuttle.connection.v1";
const connection = (): string => {
  const id =
    sessionStorage.getItem(CONNECTION_KEY) ??
    crypto.getRandomValues(new Uint32Array(4)).join(".");
  sessionStorage.setItem(CONNECTION_KEY, id);
  return id;
};

export function safePlaneFetch(
  planeApiUrl: string,
  auth: Pick<IPlaneAuth, "acquireToken" | "invalidateToken">,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): typeof globalThis.fetch {
  const planeOrigin = new URL(planeApiUrl).origin;
  return async (input, init = {}) => {
    const url = new URL(requestUrl(input));
    if (url.origin !== planeOrigin) {
      throw new Error("Blocked a request outside the configured origin.");
    }
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${await auth.acquireToken()}`);
    headers.set("X-Connection-Id", connection());
    const response = await fetch(input, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (response.status === 401) {
      auth.invalidateToken();
    }
    return response;
  };
}

export const IPlaneClient = new Token<PlaneClient>(
  "@cybershuttle/jupyter:IPlaneClient",
  "The shared CyberShuttle API client.",
);

export class PlaneClient {
  private _base: string;
  private _api: PlaneApi;
  private _auth: IPlaneAuth;
  private _tokens = new Map<string, string>();

  constructor(
    base = PageConfig.getOption("cybershuttlePlaneApiUrl"),
    auth?: IPlaneAuth,
    private _fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {
    this._base = validPlaneApiUrl(base);
    this._auth = auth ?? new AuthClient(this._base);
    this._api = planeApi(
      this._base,
      safePlaneFetch(this._base, this._auth, _fetch),
    );
  }

  async signIn(): Promise<void> {
    await this._auth.signIn();
  }

  async resumeSignIn(): Promise<void> {
    await this._auth.acquireToken();
  }

  get identity(): string | undefined {
    return this._auth.identity;
  }

  signOut(): void {
    this._auth.invalidateToken();
    sessionStorage.removeItem(CONNECTION_KEY);
  }

  async listConfigs(): Promise<Schemas["SlurmClusterConfigResponse"][]> {
    const [own, shared] = await Promise.all([
      unwrap(this._api.GET("/api/v1/slurm-cluster-configs/me")),
      unwrap(this._api.GET("/api/v1/slurm-cluster-configs/shared-with-me")),
    ]);
    return [...own, ...shared];
  }

  async addComputeHost(
    request: Schemas["SlurmClusterConfigRequest"],
  ): Promise<void> {
    await unwrap(
      this._api.POST("/api/v1/slurm-cluster-configs", { body: request }),
    );
  }

  async deleteComputeHost(id: string): Promise<void> {
    await unwrap(
      this._api.DELETE("/api/v1/slurm-cluster-configs/{slurmClusterConfigId}", {
        params: { path: { slurmClusterConfigId: id } },
      }),
    );
  }

  listSlurmClusters(): Promise<Schemas["SlurmClusterResponse"][]> {
    return unwrap(this._api.GET("/api/v1/slurm-clusters"));
  }

  listCredentials(): Promise<Schemas["SSHCredentialResponse"][]> {
    return unwrap(this._api.GET("/api/v1/ssh-credentials"));
  }

  listLoginPrompts(): Promise<Schemas["InteractiveAuthResponse"][]> {
    return unwrap(this._api.GET("/api/v1/ssh-interactive-auths"));
  }

  async answerLoginPrompt(
    authId: string,
    answer: Schemas["InteractiveAuthAnswer"],
  ): Promise<void> {
    await unwrap(
      this._api.POST("/api/v1/ssh-interactive-auths/{authId}/response", {
        params: { path: { authId } },
        body: answer,
      }),
    );
  }

  addCredential(
    request: Schemas["SSHCredentialRequest"],
  ): Promise<Schemas["SSHCredentialResponse"]> {
    return unwrap(this._api.POST("/api/v1/ssh-credentials", { body: request }));
  }

  async deleteCredential(id: string): Promise<void> {
    await unwrap(
      this._api.DELETE("/api/v1/ssh-credentials/{sshCredentialId}", {
        params: { path: { sshCredentialId: id } },
      }),
    );
  }

  async listDeployments(): Promise<IDeployment[]> {
    const [deployments, templates] = await Promise.all([
      unwrap(this._api.GET("/api/v1/slurm-deployments")),
      unwrap(this._api.GET("/api/v1/application-templates")),
    ]);
    const names = new Map(
      templates.map((each) => [each.templateId, each.templateName]),
    );
    return deployments.map((each) => ({
      ...each,
      name: names.get(each.templateId ?? "") || each.deploymentId,
    }));
  }

  async discoverSlurm(id: string, signal?: AbortSignal): Promise<ISlurmInfo> {
    const { allocations = [], partitions = [] } = await unwrap(
      this._api.POST(
        "/api/v1/slurm-cluster-configs/{slurmClusterConfigId}/discover-allocations",
        { params: { path: { slurmClusterConfigId: id } }, signal },
      ),
    );
    return {
      configId: id,
      accounts: allocations.flatMap((each) => each.account ?? []),
      partitions: partitions.map((each) => ({
        name: each.name,
        cpuCount: each.cpuPerNode ?? undefined,
        memoryMb: each.maxMemory ?? undefined,
        gres: parseGres(each.gres),
      })),
    };
  }

  async listSessions(): Promise<ISessionList> {
    const all = (await unwrap(this._api.GET("/api/v1/processes/me")))
      .filter((process) => process.batchProcess)
      .map(session);
    return {
      sessions: all.filter((each) => !isEnded(each.state)),
      runs: all
        .filter((each) => isEnded(each.state))
        .sort(
          (a, b) =>
            Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
        ),
    };
  }

  async getSession(processId: string): Promise<ISession> {
    const process = await unwrap(
      this._api.GET("/api/v1/processes/{processId}", by(processId)),
    );
    if (!process.batchProcess) {
      throw new Error("Session is no longer available.");
    }
    return session(process);
  }

  async createSession(
    batchProcess: Schemas["BatchProcessRequest"],
  ): Promise<ISession> {
    return session(
      await unwrap(
        this._api.POST("/api/v1/processes", {
          body: { processType: "BATCH_JOB", batchProcess },
        }),
      ),
    );
  }

  async startSession(processId: string): Promise<ISession> {
    return session(
      await unwrap(
        this._api.POST("/api/v1/processes/{processId}/launch", by(processId)),
      ),
    );
  }

  async stopSession(processId: string): Promise<ISession> {
    return session(
      await unwrap(
        this._api.POST("/api/v1/processes/{processId}/stop", by(processId)),
      ),
    );
  }

  async getSessionUsage({
    id,
    controlPort,
  }: Pick<ISession, "id" | "controlPort">): Promise<IUsageReport> {
    const response = await this._fetch(
      new Request(
        `${this._base}/processes/${id}/proxy/${controlPort}/api/v1/usage`,
        { headers: { Authorization: `token ${this._tokens.get(id)}` } },
      ),
      { cache: "no-store", credentials: "omit" },
    );
    if (!response.ok) throw await planeError(response);
    return response.json();
  }

  async getSessionLogs(processId: string): Promise<ISessionLogTail> {
    const statuses = await unwrap(
      this._api.GET("/api/v1/processes/{processId}/statuses", by(processId)),
    );
    const lines = statuses.slice(-100).map((status) => ({
      text: status.log ?? status.status ?? "",
      at: iso(status.timestamp) ?? "",
    }));
    return { sessionId: processId, lines };
  }

  async getSessionAccess(processId: string): Promise<ISessionAccess> {
    const access = await unwrap(
      this._api.GET("/api/v1/processes/{processId}/access", by(processId)),
    );
    if (
      !access.app.uri.startsWith(`${this._base}/processes/${processId}/proxy/`)
    ) {
      throw new Error("The server named a proxy outside its own API.");
    }
    this._tokens.set(processId, access.app.token);
    return access;
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
  const baseUrl = access.app.uri;
  const reloadingFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await browserFetch(input, init);
    if (response.status === 401 || response.status === 403) {
      if (sessionStorage.getItem(JUPYTER_RELOAD_KEY) === access.processId) {
        return jsonResponse(
          {
            message:
              "Jupyter refused this session's access again; reopen the session from the Launcher.",
          },
          { status: response.status },
        );
      }
      sessionStorage.setItem(JUPYTER_RELOAD_KEY, access.processId);
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
    token: access.app.token,
    wsUrl: baseUrl.replace(/^http/, "ws"),
  });
}

function parseGres(gres: string | null | undefined): IGres[] {
  return (gres ?? "")
    .split(",")
    .filter(Boolean)
    .map((item) => {
      const [, name = item, count = "1"] = /^(.*):(\d+)$/.exec(item) ?? [];
      return { name, count: Number(count) };
    });
}

const MEMORY_MB: Record<string, number> = {
  K: 1 / 1024,
  M: 1,
  G: 1024,
  T: 1024 ** 2,
};

function memoryMb(mem: string | null | undefined): number | undefined {
  const [, amount, unit = "M"] = /^(\d+)([KMGT])?B?$/i.exec(mem ?? "") ?? [];
  return amount ? Number(amount) * MEMORY_MB[unit.toUpperCase()] : undefined;
}

const iso = (at: number | null | undefined): string | undefined =>
  at ? new Date(at).toISOString() : undefined;

function session({
  processId,
  lastStatus,
  batchProcess,
}: Schemas["ProcessResponse"]): ISession {
  const job = batchProcess!.batchJobConfig!;
  const state = lastStatus?.status ?? "CREATED";
  return {
    id: processId,
    controlPort: batchProcess!.controlPort,
    configId: batchProcess!.slurmClusterConfigId,
    deploymentId: batchProcess!.deploymentId ?? undefined,
    state,
    account: job.allocation,
    partition: job.partition ?? undefined,
    resources: {
      wallMinutes: job.wallTimeMinutes,
      cores: job.cpus ?? undefined,
      memoryMb: memoryMb(job.mem),
      gpuCount:
        job.gpus ??
        parseGres(job.gres).find((each) => each.name.startsWith("gpu"))?.count,
    },
    startedAt: iso(
      batchProcess!.batchJobStatuses
        .filter((each) => each.status === "BEGIN")
        .at(-1)?.updatedAt,
    ),
    updatedAt: iso(lastStatus?.timestamp),
    error: (state === "FAILED" && lastStatus?.log) || undefined,
  };
}
