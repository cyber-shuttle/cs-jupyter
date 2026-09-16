// The shape every view of the panel renders from. It keeps the panel and its
// views from drifting on what state means. displayState is the one place that
// overlays a relaunching terminal session with SUBMITTING for display.
import type { IMetricSample, IRun, ISession, SessionState } from "./Common";
import { isTerminal } from "./Common";
import type { ISessionLogTail } from "./ControlClient";

type IBusySessionIds = ReadonlyMap<string, "relaunch" | "action">;

export interface ISessionUiState {
  readonly sessions: readonly ISession[];
  readonly logs: ReadonlyMap<string, ISessionLogTail>;
  readonly samples: ReadonlyMap<string, readonly IMetricSample[]>;
  readonly runs: readonly IRun[];
  readonly loading: boolean;
  readonly updatesStatus: string;
  readonly error: string;
  readonly busySessionIds: IBusySessionIds;
  readonly connectingSessionId: string | undefined;
  readonly jupyterReady: ReadonlySet<string>;
  readonly signedIn: boolean;
  readonly signingIn: boolean;
  readonly account: string | undefined;
}

export const emptyState = (): ISessionUiState => ({
  sessions: [],
  logs: new Map(),
  samples: new Map(),
  runs: [],
  loading: false,
  updatesStatus: "",
  error: "",
  busySessionIds: new Map(),
  connectingSessionId: undefined,
  jupyterReady: new Set(),
  signedIn: false,
  signingIn: false,
  account: undefined,
});

export function displayState(
  session: ISession,
  busy: IBusySessionIds,
): SessionState {
  return busy.get(session.id) === "relaunch" && isTerminal(session.state)
    ? "SUBMITTING"
    : session.state;
}
