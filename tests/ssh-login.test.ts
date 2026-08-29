import { describe, expect, it, vi } from "vitest";
import { ControlError } from "../src/ControlClient";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { SshLoginDock } from "../src/SshLoginDock";
import {
  FakeOperation,
  pollPanel,
  runtimeFixture,
  runtimeListFixture,
} from "./fakes";

const base = runtimeFixture({
  id: "rt-111111111111",
  state: "STOPPED",
  sshHost: "nexus",
});

const refused = (): ControlError =>
  new ControlError(
    "ssh_authentication_required",
    "SSH authentication is required for nexus",
  );

/** A signed-in panel with its runtime modal open, which is what owns the dock.
 * The modal is closed again: one left attached keeps a document-wide focus trap
 * that would pull the caret out of the next test's terminal. */
async function opened(startRuntime: unknown, operation: FakeOperation) {
  const api = {
    signIn: vi.fn(async () => undefined),
    listRuntimes: vi.fn(async () => runtimeListFixture([base])),
    listSshHosts: vi.fn(async () => []),
    sshAuthWebSocket: vi.fn(() => vi.fn()),
    startRuntime,
  };
  const panel = new CyberShuttlePanel(
    api as any,
    {
      currentRuntimeId: undefined,
      select: vi.fn(),
    } as any,
  );
  (panel as any)._loginDockWidget = () => new SshLoginDock(() => operation);
  await panel.signIn();
  await vi.waitFor(() => expect(panel.state.runtimes.length).toBe(1));
  const open = panel.openRuntime(base.id);
  await vi.waitFor(() =>
    expect(document.querySelector(".csLoginDock")).not.toBeNull(),
  );
  return {
    panel,
    api,
    close: async () => {
      (panel as any)._detailDialog?.resolve(0);
      await open;
      panel.dispose();
    },
  };
}

const awaitingLogin = (operation: FakeOperation): Promise<void> =>
  vi.waitFor(() => expect(operation.starts.length).toBe(1));

describe("a runtime action a host refuses for a login", () => {
  it("offers the login and runs the action again once it is done", async () => {
    const operation = new FakeOperation();
    const { panel, api, close } = await opened(
      vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce({ ...base, state: "QUEUED" as const }),
      operation,
    );

    const running = panel.runAgain(base.id);
    await awaitingLogin(operation);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(panel.state.error).toBe("");

    operation.starts[0].callbacks.ready();
    await running;
    expect(api.startRuntime).toHaveBeenCalledTimes(2);
    expect(panel.state.runtimes[0].state).toBe("QUEUED");
    await close();
  });

  // The retry is outside the try, so a second refusal is reported rather than
  // opening another login.
  it("does not offer a second login when the host refuses again", async () => {
    const operation = new FakeOperation();
    const { panel, api, close } = await opened(
      vi.fn().mockRejectedValue(refused()),
      operation,
    );

    const running = panel.runAgain(base.id);
    await awaitingLogin(operation);
    operation.starts[0].callbacks.ready();
    await running;
    expect(api.startRuntime).toHaveBeenCalledTimes(2);
    expect(operation.starts).toHaveLength(1);
    expect(panel.state.error).toContain("SSH authentication is required");
    await close();
  });

  it("leaves a failure that is not a login refusal alone", async () => {
    const operation = new FakeOperation();
    const { panel, close } = await opened(
      vi.fn().mockRejectedValue(new Error("Slurm said no.")),
      operation,
    );
    await panel.runAgain(base.id);
    expect(operation.starts).toHaveLength(0);
    expect(panel.state.error).toBe("Slurm said no.");
    await close();
  });

  it("reports a login the person could not complete", async () => {
    const operation = new FakeOperation();
    const { panel, api, close } = await opened(
      vi.fn().mockRejectedValue(refused()),
      operation,
    );

    const running = panel.runAgain(base.id);
    await awaitingLogin(operation);
    operation.starts[0].callbacks.failed("Permission denied.");
    await running;
    expect(panel.state.error).toBe("Permission denied.");
    expect(api.startRuntime).toHaveBeenCalledTimes(1);
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    await close();
  });

  // Why the console is a sibling of the runtime view rather than a child: the
  // view rebuilds its subtree several times per poll, and keepingFocus cannot
  // restore an xterm textarea, which carries no data-runtime-action.
  it("keeps the terminal mounted and focused across the poll", async () => {
    const operation = new FakeOperation();
    const prompt = document.createElement("input");
    operation.node.appendChild(prompt);
    const { panel, close } = await opened(
      vi.fn().mockRejectedValueOnce(refused()),
      operation,
    );

    void panel.runAgain(base.id);
    await awaitingLogin(operation);
    prompt.focus();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(operation.node.isConnected).toBe(true);
    expect(document.activeElement).toBe(prompt);
    await close();
  });

  // The console reports nothing after its generation moves on, so a dock
  // dismissed without settling leaves the card spinning for good.
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
