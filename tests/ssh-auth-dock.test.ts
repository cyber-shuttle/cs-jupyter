// Session actions that an SSH host refuses pending SSH authentication through
// the dock. Stop and Delete open their own confirmation by rejecting the detail
// dialog first, including through its own close control. The dock sits inside
// the open dialog without being its child, so it survives that rejection. The
// dock, a fixed overlay, vanishes once SSH authentication succeeds and returns
// for the next one on the same instance.
import { describe, expect, it, vi } from "vitest";
import { PlaneError } from "../src/Common";
import { SshAuthDock } from "../src/ssh";
import {
  FakeOperation,
  acceptDialog,
  planeFake,
  panelFake,
  pollPanel,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const base = sessionFixture({
  id: "s-111111111111",
  state: "STOPPED",
  alias: "nexus",
});

const refused = (): PlaneError =>
  new PlaneError(
    "ssh_authentication_required",
    "SSH authentication is required for nexus",
  );

async function opened(
  startSession: unknown,
  operation: FakeOperation,
  extraApi: Record<string, unknown> = {},
) {
  const api = planeFake({
    listSessions: vi.fn(async () => sessionListFixture([base])),
    sshAuthWebSocket: vi.fn(() => vi.fn()),
    startSession,
    ...extraApi,
  });
  const panel = panelFake(api);
  (panel as any)._modals._sshAuthDockWidget = () =>
    new SshAuthDock(() => operation);
  await panel.restored;
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

const awaitingAuthentication = (operation: FakeOperation): Promise<void> =>
  vi.waitFor(() => expect(operation.starts.length).toBe(1));

const completeAuthentication = (operation: FakeOperation): void => {
  const { ready } = operation.starts[0].callbacks;
  expect(ready).toBeDefined();
  ready?.();
};

async function refusedStart() {
  const operation = new FakeOperation();
  const { panel, api, close } = await openedRefused(operation);
  const running = panel.actions.start(base.id);
  await awaitingAuthentication(operation);
  return { operation, panel, api, close, running };
}

describe("a session action an SSH host refuses for SSH authentication", () => {
  it("offers SSH authentication and retries the action once it is done", async () => {
    const operation = new FakeOperation();
    const { panel, api, close } = await opened(
      vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce({ ...base, state: "QUEUED" as const }),
      operation,
    );

    const running = panel.actions.start(base.id);
    await awaitingAuthentication(operation);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(panel.state.error).toBe("");

    completeAuthentication(operation);
    await running;
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(panel.state.sessions[0].state).toBe("QUEUED");
    await close();
  });

  it("does not offer SSH authentication twice when the SSH host refuses again", async () => {
    const { operation, panel, api, close, running } = await refusedStart();
    completeAuthentication(operation);
    await running;
    expect(api.startSession).toHaveBeenCalledTimes(2);
    expect(operation.starts).toHaveLength(1);
    expect(panel.state.error).toContain("SSH authentication is required");
    await close();
  });

  it("offers SSH authentication and retries stop once the confirmation is accepted", async () => {
    const operation = new FakeOperation();
    const stopSession = vi
      .fn()
      .mockRejectedValueOnce(refused())
      .mockResolvedValueOnce({ ...base, state: "STOPPING" as const });
    const { panel, api, close } = await opened(vi.fn(), operation, {
      stopSession,
    });

    const dock = panel.modals.sshAuthDock;
    const stopping = panel.actions.stop(base.id);
    await acceptDialog();
    await awaitingAuthentication(operation);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(dock.isDisposed).toBe(false);
    expect(document.body.contains(dock.node)).toBe(true);

    completeAuthentication(operation);
    await stopping;
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(panel.state.sessions[0].state).toBe("STOPPING");
    expect(operation.disposed).toBe(false);
    await close();
  });

  it("reports SSH authentication the person could not complete", async () => {
    const { operation, panel, api, close, running } = await refusedStart();
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

    void panel.actions.start(base.id);
    await awaitingAuthentication(operation);
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

    const running = panel.actions.start(base.id);
    await awaitingAuthentication(operation);
    const dock = panel.modals.sshAuthDock;
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

  it("settles the action when the modal is dismissed mid-authentication", async () => {
    const operation = new FakeOperation();
    const dock = new SshAuthDock(() => operation);
    const auth = dock.authenticate("nexus", vi.fn());
    await awaitingAuthentication(operation);
    dock.dispose();
    await expect(auth).rejects.toThrow("dismissed");
    expect(operation.disposed).toBe(true);
  });
});

function startedAuthentication() {
  const operation = new FakeOperation();
  const dock = new SshAuthDock(() => operation);
  const auth = dock.authenticate("nexus", vi.fn());
  expect(dock.isHidden).toBe(false);
  return { operation, dock, auth };
}

describe("SshAuthDock visibility", () => {
  it("hides itself once SSH authentication succeeds, and shows again on the next one", async () => {
    const { operation, dock, auth } = startedAuthentication();

    const { ready } = operation.starts[0].callbacks;
    ready?.();
    await auth;
    expect(dock.isHidden).toBe(true);

    dock.authenticate("nexus", vi.fn());
    expect(dock.isHidden).toBe(false);
    expect(operation.starts).toHaveLength(2);
  });

  it("hides itself once SSH authentication fails, leaving no stranded dismiss control", async () => {
    const { operation, dock, auth } = startedAuthentication();

    const { failed } = operation.starts[0].callbacks;
    failed?.("Authentication failed.");
    await expect(auth).rejects.toThrow("Authentication failed.");
    expect(dock.isHidden).toBe(true);
  });
});
