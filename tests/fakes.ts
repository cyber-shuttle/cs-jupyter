import { vi } from "vitest";
import type { IRuntime } from "../src/Common";
import type { IRuntimeList, IRuntimeLogTail } from "../src/ControlClient";
import type { IRuntimeUiState } from "../src/CyberShuttlePanel";
import { emptyState } from "../src/RuntimeList";
import type { OAuthWebSocketConnector } from "../src/OAuthWebSocket";
import type {
  ISshOperationCallbacks,
  ISshOperationConsole,
} from "../src/SshOperationConsole";

/** Runs one poll on a panel, as if its timer had just fired. */
export async function pollPanel(panel: unknown): Promise<void> {
  await (panel as { _poll(): Promise<void> })._poll();
}

export class FakeOperation implements ISshOperationConsole {
  readonly node = document.createElement("div");
  starts: Array<{
    connect: OAuthWebSocketConnector;
    callbacks: ISshOperationCallbacks;
  }> = [];
  completed: string[] = [];
  focused = 0;
  cancelled = 0;
  disposed = false;

  start(
    connect: OAuthWebSocketConnector,
    callbacks: ISshOperationCallbacks,
  ): void {
    this.starts.push({ connect, callbacks });
  }
  complete = (message: string): void => void this.completed.push(message);
  focus = (): void => void this.focused++;
  cancel = (): void => void this.cancelled++;
  dispose = (): void => void (this.disposed = true);
}

// One runtime fixture. Every panel test declared its own near-identical 12-line literal.
export function runtimeFixture(overrides: Partial<IRuntime> = {}): IRuntime {
  return {
    id: "rt-012345abcdef",
    generation: "g-0123456789abcdef",
    state: "READY",
    sshHost: "delta",
    partition: "debug",
    rootFolder: "projects/demo",
    resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

// The panel's own defaults, so a test only states the fields it is exercising.
export function uiState(
  overrides: Partial<IRuntimeUiState> = {},
): IRuntimeUiState {
  return { ...emptyState(), ...overrides };
}

export function runtimeListFixture(
  runtimes: IRuntime[] = [],
  logs: IRuntimeLogTail[] = [],
  refreshing = false,
): IRuntimeList {
  return { runtimes, refreshing, logs };
}

/** The token provider a ControlClient needs, stubbed. */
export function fakeAuth(accessToken = "delegated-token") {
  return {
    acquireToken: vi.fn(async () => ({
      accessToken,
      idToken: "identity-token",
    })),
  };
}
