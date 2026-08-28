import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
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
  account: "pearc26-tutorial",
});

const refused = (): ControlError =>
  new ControlError(
    "ssh_authentication_required",
    "SSH authentication is required for nexus",
  );

function panelWith(
  api: Record<string, unknown>,
  operation: FakeOperation,
): CyberShuttlePanel {
  const panel = new CyberShuttlePanel(
    api as any,
    {
      currentRuntimeId: undefined,
      select: vi.fn(),
    } as any,
  );
  (panel as any)._consoleFactory = () => operation;
  return panel;
}

/** Opens the runtime modal, which is what owns the login dock, and closes it
 * again: a dialog left attached keeps a document-wide focus trap that would
 * pull the caret out of the next test's terminal. */
async function openModal(
  panel: CyberShuttlePanel,
): Promise<() => Promise<void>> {
  await panel.signIn();
  await vi.waitFor(() => expect(panel.state.runtimes.length).toBe(1));
  const open = panel.openRuntime(base.id);
  await vi.waitFor(() =>
    expect(document.querySelector(".csLoginDock")).not.toBeNull(),
  );
  return async () => {
    (panel as any)._detailDialog?.resolve(0);
    await open;
    panel.dispose();
  };
}

describe("a runtime action a host refuses for a login", () => {
  it("offers the login and runs the action again once it is done", async () => {
    const operation = new FakeOperation();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      sshAuthWebSocket: vi.fn(() => vi.fn()),
      startRuntime: vi
        .fn()
        .mockRejectedValueOnce(refused())
        .mockResolvedValueOnce({ ...base, state: "QUEUED" as const }),
    };
    const panel = panelWith(api, operation);
    const close = await openModal(panel);

    const running = panel.runAgain(base.id);
    await vi.waitFor(() => expect(operation.starts.length).toBe(1));
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("nexus");
    expect(document.querySelector(".csLoginDock")?.textContent).toContain(
      "nexus",
    );
    // Nothing is reported as failed while the person is still signing in.
    expect(panel.state.error).toBe("");

    operation.starts[0].callbacks.ready();
    await running;
    expect(api.startRuntime).toHaveBeenCalledTimes(2);
    expect(panel.state.runtimes[0].state).toBe("QUEUED");
    expect(panel.state.error).toBe("");
    await close();
  });

  // The retry sits outside the try, so a host that refuses again reports that
  // refusal rather than starting a second login.
  it("does not offer a second login when the host refuses again", async () => {
    const operation = new FakeOperation();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      sshAuthWebSocket: vi.fn(() => vi.fn()),
      startRuntime: vi.fn().mockRejectedValue(refused()),
    };
    const panel = panelWith(api, operation);
    const close = await openModal(panel);

    const running = panel.runAgain(base.id);
    await vi.waitFor(() => expect(operation.starts.length).toBe(1));
    operation.starts[0].callbacks.ready();
    await running;
    expect(api.startRuntime).toHaveBeenCalledTimes(2);
    expect(operation.starts.length).toBe(1);
    expect(panel.state.error).toContain("SSH authentication is required");
    await close();
  });

  it("leaves a failure that is not a login refusal alone", async () => {
    const operation = new FakeOperation();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      sshAuthWebSocket: vi.fn(() => vi.fn()),
      startRuntime: vi.fn().mockRejectedValue(new Error("Slurm said no.")),
    };
    const panel = panelWith(api, operation);
    const close = await openModal(panel);
    await panel.runAgain(base.id);
    expect(operation.starts).toHaveLength(0);
    expect(panel.state.error).toBe("Slurm said no.");
    await close();
  });

  it("reports a login the person could not complete", async () => {
    const operation = new FakeOperation();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      sshAuthWebSocket: vi.fn(() => vi.fn()),
      startRuntime: vi.fn().mockRejectedValue(refused()),
    };
    const panel = panelWith(api, operation);
    const close = await openModal(panel);

    const running = panel.runAgain(base.id);
    await vi.waitFor(() => expect(operation.starts.length).toBe(1));
    operation.starts[0].callbacks.failed("Permission denied.");
    await running;
    expect(panel.state.error).toBe("Permission denied.");
    expect(api.startRuntime).toHaveBeenCalledTimes(1);
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    await close();
  });

  // The whole reason the console is a sibling of the runtime view rather than a
  // child of it: the view rebuilds its subtree several times per poll, which
  // would pull the terminal out of the document and drop the caret of whoever
  // is typing a password. keepingFocus cannot help -- it only restores elements
  // carrying data-runtime-action, which xterm's textarea does not.
  it("keeps the terminal mounted and focused across the poll", async () => {
    const operation = new FakeOperation();
    const prompt = document.createElement("input");
    operation.node.appendChild(prompt);
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      sshAuthWebSocket: vi.fn(() => vi.fn()),
      startRuntime: vi.fn().mockRejectedValueOnce(refused()),
    };
    const panel = panelWith(api, operation);
    const close = await openModal(panel);

    void panel.runAgain(base.id);
    await vi.waitFor(() => expect(operation.starts.length).toBe(1));
    prompt.focus();
    expect(document.activeElement).toBe(prompt);

    await pollPanel(panel);
    await pollPanel(panel);
    expect(operation.node.isConnected).toBe(true);
    expect(document.activeElement).toBe(prompt);
    await close();
  });

  // The console reports nothing after cancel(), so a dock that is dismissed
  // without settling would leave the card spinning for good.
  it("settles the action when the modal is dismissed mid-login", async () => {
    const operation = new FakeOperation();
    const dock = new SshLoginDock(() => operation);
    const login = dock.login("nexus", vi.fn());
    await vi.waitFor(() => expect(operation.starts.length).toBe(1));
    dock.dispose();
    await expect(login).rejects.toThrow("dismissed");
    expect(operation.disposed).toBe(true);
  });
});
