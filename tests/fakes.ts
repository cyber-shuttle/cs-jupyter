// Shared test doubles and fixtures: fake auth, control client and SSH console,
// plus sessions and runs used across suites. FakeOperation rejects start after
// disposal because the real SSH console does too. acceptDialog exists because
// stopping and deleting a session both confirm first.
import { vi } from "vitest";
import { Signal } from "@lumino/signaling";
import type { Widget } from "@lumino/widgets";
import type { ReadonlyPartialJSONObject } from "@lumino/coreutils";
import type { IRun, ISession } from "../src/Common";
import type {
  IControlAuth,
  ISessionList,
  ISessionLogTail,
} from "../src/ControlClient";
import type { ISessionAccess } from "../src/session";
import { ControlClient } from "../src/ControlClient";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { jsonResponse } from "../src/Common";
import { emptyState, type ISessionUiState } from "../src/session";
import type { OAuthWebSocketConnector } from "../src/ssh";
import type { ISshOperationCallbacks, ISshOperationConsole } from "../src/ssh";

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

export class FakeOperation implements ISshOperationConsole {
  readonly node = document.createElement("div");
  starts: Array<{
    connect: OAuthWebSocketConnector;
    callbacks: ISshOperationCallbacks;
  }> = [];
  disposed = false;

  start(
    connect: OAuthWebSocketConnector,
    callbacks: ISshOperationCallbacks,
  ): void {
    if (this.disposed) {
      throw new Error("Cannot start a disposed SSH operation console.");
    }
    this.starts.push({ connect, callbacks });
  }
  complete = (): void => {};
  focus = (): void => {};
  dispose = (): void => void (this.disposed = true);
}

export function sessionFixture(overrides: Partial<ISession> = {}): ISession {
  return {
    id: "s-012345abcdef",
    seq: 1,
    state: "READY",
    launcher: "cs-plane",
    sshHost: "delta",
    partition: "debug",
    rootFolder: "projects/demo",
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 30 },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

export function runFixture(overrides: Partial<IRun> = {}): IRun {
  return {
    sessionId: "s-012345abcdef",
    seq: 1,
    sshHost: "delta",
    partition: "cpu",
    rootFolder: "$HOME/project",
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    finalState: "STOPPED",
    startedAt: "2030-01-01T00:00:00Z",
    endedAt: "2030-01-01T01:00:00Z",
    ...overrides,
  };
}

export function uiState(
  overrides: Partial<ISessionUiState> = {},
): ISessionUiState {
  return { ...emptyState(), ...overrides };
}

export function accessFixture(
  sessionId: string,
  seq: number,
  overrides: Partial<ISessionAccess> = {},
): ISessionAccess {
  return {
    sessionId,
    seq,
    expiresAt: "2030-01-01T00:00:00Z",
    jupyter: {
      uri: `http://localhost:3000/api/v1/sessions/${sessionId}/jupyter/`,
      token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    ...overrides,
  };
}

export function controlFake<T extends object>(overrides = {} as T) {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(),
    resumeSignIn: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => sessionListFixture()),
    listSshHosts: vi.fn(async () => []),
    listSshKeys: vi.fn(async () => []),
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

export class ControllerFake {
  readonly stateChanged = new Signal<this, ISessionUiState>(this);
  readonly actions = {
    runAgain: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };

  constructor(public state: ISessionUiState) {}

  get sessions(): readonly ISession[] {
    return this.state.sessions;
  }

  setState(state: ISessionUiState): void {
    this.state = state;
    this.stateChanged.emit(state);
  }
}

export function sessionListFixture(
  sessions: ISession[] = [],
  logs: ISessionLogTail[] = [],
): ISessionList {
  return { sessions, logs };
}

export function fakeAuth(idToken = "delegated-token") {
  return {
    acquireToken: vi.fn(async () => ({ idToken })),
    interactiveLogin: vi.fn(async () => undefined),
  } satisfies IControlAuth;
}

export const etagResponse = (value: unknown, etag: string): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ETag: etag },
  });

export const clientFor = (value: unknown): ControlClient =>
  new ControlClient(
    "https://control.example.edu/api/v1",
    fakeAuth(),
    vi.fn<typeof globalThis.fetch>(async () => jsonResponse(value)),
  );

export async function removeConfirmed(
  panel: CyberShuttlePanel,
  id: string,
): Promise<void> {
  const removing = panel.actions.remove(id);
  await acceptDialog();
  await removing;
}

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
