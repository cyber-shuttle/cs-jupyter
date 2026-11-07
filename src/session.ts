// A session's URL and on-screen state. The URL carries the session id or
// nothing. The active session is the one this page attached to.
import type { IDeployment, IUsageSample, ISession, Schemas } from "./Common";
import { UUID, clusterLabel } from "./Common";
import type { ISessionLogTail } from "./PlaneClient";

export function selectedSession(
  search = window.location.search,
): { sessionId: string } | undefined {
  const query = new URLSearchParams(search);
  const sessionId = query.get("session") ?? "";
  const workspace = query.get("workspace") ?? "";
  return UUID.test(sessionId) && workspace === sessionId
    ? { sessionId }
    : undefined;
}

export function sessionHomeUrl(): string {
  const url = new URL("index.html", window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function sessionLiteUrl(
  sessionId: string,
  documentPath?: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("session", sessionId);
  url.searchParams.set("workspace", sessionId);
  documentPath
    ? url.searchParams.set("path", documentPath)
    : url.searchParams.delete("path");
  return url.toString();
}

let activeSessionId: string | undefined;

export function setActiveSession(id: string | undefined): void {
  activeSessionId = id;
}

export function getActiveSessionId(): string | undefined {
  return activeSessionId;
}

export interface ISessionUiState {
  readonly sessions: readonly ISession[];
  readonly logs: ReadonlyMap<string, ISessionLogTail>;
  readonly samples: ReadonlyMap<string, readonly IUsageSample[]>;
  readonly clusters: readonly Schemas["SlurmClusterConfigResponse"][];
  readonly deployments: readonly IDeployment[];
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly createBlocked: string;
  readonly busySessionIds: ReadonlySet<string>;
  readonly connectingSessionId: string | undefined;
  readonly jupyterReady: ReadonlySet<string>;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly identity: string | undefined;
}

export const emptyState = (): ISessionUiState => ({
  sessions: [],
  logs: new Map(),
  samples: new Map(),
  clusters: [],
  deployments: [],
  loading: false,
  updatesStatus: "",
  error: "",
  createBlocked: "",
  busySessionIds: new Set(),
  connectingSessionId: undefined,
  jupyterReady: new Set(),
  signedIn: false,
  signingIn: false,
  identity: undefined,
});

export const RUN_REPORT_KEY = "cybershuttle.run-report.v1";

export const sessionTitle = (
  state: Pick<ISessionUiState, "clusters" | "deployments">,
  session: Pick<ISession, "slurmClusterConfigId" | "deploymentId">,
): string =>
  [
    clusterLabel(state.clusters, session.slurmClusterConfigId),
    state.deployments.find((each) => each.deploymentId === session.deploymentId)
      ?.name,
  ]
    .filter(Boolean)
    .join(" · ");
