// Session actions that a host refuses pending an SSH login through the login
// dock. Stop and Delete open their own confirmation by rejecting the detail
// dialog first, including through its own close control. The dock sits inside
// the open dialog without being its child, so it survives that rejection. The
// dock, a fixed overlay, vanishes once a login succeeds and returns for the
// next login on the same instance.
import { describe, expect, it, vi } from "vitest";
import { ControlError } from "../src/ControlClient";
import { SshLoginDock } from "../src/ssh";
import {
  FakeOperation,
  acceptDialog,
  controlFake,
  panelFake,
  pollPanel,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const base = sessionFixture({
  id: "s-111111111111",
  state: "STOPPED",
  sshHost: "nexus",
});

const refused = (): ControlError =>
  new ControlError(
    "ssh_authentication_required",
    "SSH authentication is required for nexus",
  );

async function opened(
  startSession: unknown,
  operation: FakeOperation,
  extraApi: Record<string, unknown> = {},
) {
  const api = controlFake({
    listSessions: vi.fn(async () => sessionListFixture([base])),
    sshAuthWebSocket: vi.fn(() => vi.fn()),
    startSession,
    ...extraApi,
  });
  const panel = panelFake(api);
  (panel as any)._modals._loginDockWidget = () =>
    new SshLoginDock(() => operation);
  await panel.signIn();
  await vi.waitFor(() => expect(panel.state.sessions.length).toBe(1));
  const open = panel.modals.openSession(base.id);
  await vi.waitFor(() =>
    expect(document.querySelector(".csSessionDetail")).not.toBeNull(),
  );
  return {
    panel,
    api,
    close: async () => {
      (panel as any)._modals.rejectDetail();
      await open;
      panel.dispose();
    },
  };
}

async function openedRefused(operation: FakeOperation) {
  return opened(vi.fn().mockRejectedValue(refused()), operation);
}

const awaitingLogin = (operation: FakeOperation): Promise<void> =>
  vi.waitFor(() => expect(operation.starts.length).toBe(1));

const completeLogin = (operation: FakeOperation): void => {
  const { ready } = operation.starts[0].callbacks;
  expect(ready).toBeDefined();
  ready?.();
};

async function refusedRunAgain() {
  const operation = new FakeOperation();
  const { panel, api, close } = await openedRefused(operation);
  const running = panel.actions.runAgain(base.id);
  await awaitingLogin(operation);
  return { operation, panel, api, close, running };
}

describe("a session action a host refuses for a login", () => {
  it("offers the login and runs the action again once it is done", async () => {
    const operation = new FakeOperation();
    const { panel, api, close } = await opened(
      vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce({ ...base, state: "QUEUED" as const }),
      operation,
    );

    const running = panel.actions.runAgain(base.id);
    await awaitingLogin(operation);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(panel.state.error).toBe("");

    completeLogin(operation);
    await running;
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(panel.state.sessions[0].state).toBe("QUEUED");
    await close();
  });

  it("does not offer a second login when the host refuses again", async () => {
    const { operation, panel, api, close, running } = await refusedRunAgain();
    completeLogin(operation);
    await running;
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(operation.starts).toHaveLength(1);
    expect(panel.state.error).toContain("SSH authentication is required");
    await close();
  });

  it("offers the login and retries stop once the confirmation is accepted", async () => {
    const operation = new FakeOperation();
    const stopSession = vi
      .fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ ...base, state: "STOPPING" as const });
    const { panel, api, close } = await opened(vi.fn(), operation, {
      stopSession,
    });

    const dock = panel.modals.loginDock;
    const stopping = panel.actions.stop(base.id);
    await acceptDialog();
    await awaitingLogin(operation);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(dock.isDisposed).toBe(false);
    expect(document.body.contains(dock.node)).toBe(true);

    completeLogin(operation);
    await stopping;
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(panel.state.sessions[0].state).toBe("STOPPING");
    expect(operation.disposed).toBe(false);
    await close();
  });

  it("reports a login the person could not complete", async () => {
    const { operation, panel, api, close, running } = await refusedRunAgain();
    operation.starts[0].callbacks.failed("Permission denied.");
    await running;
    expect(panel.state.error).toBe("Permission denied.");
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);
    await close();
  });

  it("keeps the terminal mounted and focused across the poll", async () => {
    const operation = new FakeOperation();
    const prompt = document.createElement("input");
    operation.node.appendChild(prompt);
    const { panel, close } = await opened(
      vi.fn().mockRejectedValueOnce(refused()),
      operation,
    );

    void panel.actions.runAgain(base.id);
    await awaitingLogin(operation);
    prompt.focus();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(operation.node.isConnected).toBe(true);
    expect(document.activeElement).toBe(prompt);
    await close();
  });

  it("survives the detail dialog's own close control, not just rejectDetail", async () => {
    const operation = new FakeOperation();
    const startSession = vi
      .fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ ...base, state: "QUEUED" as const });
    const { panel, api } = await opened(startSession, operation);

    const running = panel.actions.runAgain(base.id);
    await awaitingLogin(operation);
    const dock = panel.modals.loginDock;
    expect(document.querySelector(".jp-Dialog")!.contains(dock.node)).toBe(
      true,
    );

    for (const dialog of (panel as any)._modals._detailDialogs) {
      dialog.reject();
    }
    await vi.waitFor(() =>
      expect(document.querySelector(".jp-Dialog")).toBeNull(),
    );
    expect(dock.isDisposed).toBe(false);
    expect(dock.node.parentElement).toBe(document.body);

    operation.starts[0].callbacks.ready?.();
    await running;
    expect(api.startSession).toHaveBeenCalledTimes(2);

    dock.dispose();
    panel.dispose();
  });

  it("settles the action when the modal is dismissed mid-login", async () => {
    const operation = new FakeOperation();
    const dock = new SshLoginDock(() => operation);
    const login = dock.login("nexus", vi.fn());
    await awaitingLogin(operation);
    dock.dispose();
    await expect(login).rejects.toThrow("dismissed");
    expect(operation.disposed).toBe(true);
  });
});

function startedLogin() {
  const operation = new FakeOperation();
  const dock = new SshLoginDock(() => operation);
  const login = dock.login("nexus", vi.fn());
  expect(dock.isHidden).toBe(false);
  return { operation, dock, login };
}

describe("SshLoginDock visibility", () => {
  it("hides itself once a login succeeds, and shows again on the next login", async () => {
    const { operation, dock, login } = startedLogin();

    const { ready } = operation.starts[0].callbacks;
    ready?.();
    await login;
    expect(dock.isHidden).toBe(true);

    dock.login("nexus", vi.fn());
    expect(dock.isHidden).toBe(false);
    expect(operation.starts).toHaveLength(2);
  });

  it("hides itself once a login fails, leaving no stranded dismiss control", async () => {
    const { operation, dock, login } = startedLogin();

    const { failed } = operation.starts[0].callbacks;
    failed?.("Authentication failed.");
    await expect(login).rejects.toThrow("Authentication failed.");
    expect(dock.isHidden).toBe(true);
  });
});
