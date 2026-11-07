// Shared test doubles and fixtures: fake auth and CyberShuttle API client, plus
// the records used across suites. acceptDialog exists because stopping a
// session confirms first.
import { vi } from "vitest";
import { Signal } from "@lumino/signaling";
import type { Widget } from "@lumino/widgets";
import type { ReadonlyPartialJSONObject } from "@lumino/coreutils";
import type {
  IDeployment,
  IPlaneAuth,
  IRun,
  ISession,
  Schemas,
} from "../src/Common";
import type { ISessionAccess, ISessionLogTail } from "../src/PlaneClient";
import { PlaneClient } from "../src/PlaneClient";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { jsonResponse } from "../src/Common";
import { emptyState, type ISessionUiState } from "../src/session";

export async function pollPanel(panel: unknown): Promise<void> {
  await (panel as { _poll(): Promise<void> })._poll();
}

export function fakeCommandApp() {
  const execute = vi.fn<
    (command: string, args?: ReadonlyPartialJSONObject) => Promise<void>
  >(async () => undefined);
  const app = {
    commands: { execute, hasCommand: vi.fn(() => true) },
    shell: { currentWidget: null },
  };
  return { execute, app };
}

export function fakeApp(
  current: Widget,
  currentChanged: Signal<unknown, { newValue: Widget | null }>,
) {
  return {
    commands: {
      addCommand: vi.fn(),
      execute: vi.fn(),
      hasCommand: () => true,
    },
    shell: {
      currentWidget: current,
      widgets: () => [current].values(),
      activateById: vi.fn(),
      currentChanged,
    },
    restored: Promise.resolve(),
  };
}

export const CLUSTER_ID = "9c2c0d01-f156-4f3a-9e4f-a2aebffa8ded";
export const SLURM_CLUSTER_ID = "c1d2e3f4-5678-4abc-9def-0123456789ab";
export const DEPLOYMENT_ID = "3f6a2c1e-8b7d-4e5f-9a0b-1c2d3e4f5a6b";

export const processId = (n: number): string =>
  `6b9d2a4e-6f1c-4b1e-9b7a-${String(n).padStart(12, "0")}`;
export const PROCESS_ID = processId(0);

export const CREDENTIAL_ID = "5e8f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

export const credentialFixture = (): Schemas["SSHCredentialResponse"] => ({
  sshCredentialId: CREDENTIAL_ID,
  sshCredentialName: "laptop",
  publicKey: "ssh-ed25519 AAAA me@laptop",
  fullInteractive: false,
  ownerId: "me",
});

export const slurmClusterFixture = (): Schemas["SlurmClusterResponse"] => ({
  slurmClusterId: SLURM_CLUSTER_ID,
  clusterName: "hpc-a",
  headnodeHost: "login.example.edu",
  headnodePort: 22,
  partitions: [],
});

export const clusterFixture = (
  overrides: Partial<Schemas["SlurmClusterConfigResponse"]> = {},
): Schemas["SlurmClusterConfigResponse"] => ({
  slurmClusterConfigId: CLUSTER_ID,
  name: "hpc-a",
  ownerId: "me",
  slurmClusterId: SLURM_CLUSTER_ID,
  slurmCluster: slurmClusterFixture(),
  loginUser: "me",
  workRoot: "/home/me",
  sshCredentialId: CREDENTIAL_ID,
  sshCredential: credentialFixture(),
  ...overrides,
});

export const deploymentFixture = (): IDeployment => ({
  deploymentId: DEPLOYMENT_ID,
  templateId: null,
  slurmClusterId: SLURM_CLUSTER_ID,
  slurmRunSection: "",
  name: "JupyterLab",
});

export const sessionId = (n: number): string =>
  `2c4e6a8b-1d3f-4a5c-8e7b-${String(n).padStart(12, "0")}`;
export const SESSION_ID = sessionId(0);

export const runFixture = (overrides: Partial<IRun> = {}): IRun => ({
  processId: PROCESS_ID,
  controlPort: 24000,
  state: "READY",
  startedAt: null,
  deadline: null,
  endedAt: null,
  error: null,
  ...overrides,
});

export function sessionFixture(
  overrides: Partial<ISession> = {},
  run: Partial<IRun> = {},
): ISession {
  return {
    sessionId: SESSION_ID,
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    slurmClusterConfigId: CLUSTER_ID,
    deploymentId: DEPLOYMENT_ID,
    account: "project-a",
    partition: "debug",
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 30 },
    state: "READY",
    live: true,
    runs: [runFixture({ state: overrides.state ?? "READY", ...run })],
    ...overrides,
  };
}

export function uiState(
  overrides: Partial<ISessionUiState> = {},
): ISessionUiState {
  return {
    ...emptyState(),
    clusters: [clusterFixture()],
    deployments: [deploymentFixture()],
    ...overrides,
  };
}

export function accessFixture(
  processId: string,
  overrides: Partial<ISessionAccess> = {},
): ISessionAccess {
  return {
    processId,
    app: {
      uri: `http://localhost:3000/api/v1/processes/${processId}/proxy/24001/`,
      token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    ...overrides,
  };
}

export function planeFake<T extends object>(overrides = {} as T) {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(),
    resumeSignIn: vi.fn(async () => undefined),
    listSessions: vi.fn(async (): Promise<ISession[]> => []),
    listConfigs: vi.fn(async () => [clusterFixture()]),
    listDeployments: vi.fn(async () => [deploymentFixture()]),
    listSlurmClusters: vi.fn(async () => [slurmClusterFixture()]),
    listCredentials: vi.fn(async () => [credentialFixture()]),
    listLoginPrompts: vi.fn(async () => []),
    addComputeHost: vi.fn(async () => undefined),
    addCredential: vi.fn(async () => undefined),
    getSessionLogs: vi.fn(async (processId: string) => logTail(processId)),
    getSessionAccess: vi.fn(async (id: string) => accessFixture(id)),
    ...overrides,
  };
}

export function panelFake(
  api: object,
  controller: { select?: unknown } = {},
): CyberShuttlePanel {
  return new CyberShuttlePanel(
    api as any,
    {
      select: vi.fn(),
      ...controller,
    } as any,
  );
}

export class PanelStateFake {
  readonly stateChanged = new Signal<this, ISessionUiState>(this);
  readonly logWatchers = new Set<ReadonlySet<string>>();

  constructor(public state: ISessionUiState) {}

  setState(state: ISessionUiState): void {
    this.state = state;
    this.stateChanged.emit(state);
  }
}

export const logTail = (
  processId: string,
  lines: ISessionLogTail["lines"] = [],
): ISessionLogTail => ({ processId, lines });

export function fakeAuth(idToken = "delegated-token") {
  return {
    acquireToken: vi.fn(async () => idToken),
    invalidateToken: vi.fn(),
    signIn: vi.fn(async () => undefined),
  } satisfies IPlaneAuth;
}

export const clientFor = (value: unknown): PlaneClient =>
  new PlaneClient(
    "https://plane.example.edu/api/v1",
    fakeAuth(),
    vi.fn<typeof globalThis.fetch>(async () => jsonResponse(value)),
  );

export async function acceptDialog(): Promise<void> {
  let accept: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>(".jp-Dialog button"),
    ];
    accept = buttons[buttons.length - 1];
    if (!accept) {
      throw new Error("no confirmation is open");
    }
  });
  accept!.click();
}
