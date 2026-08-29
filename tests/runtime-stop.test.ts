import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { pollPanel, runtimeFixture, runtimeListFixture } from "./fakes";

const base = runtimeFixture({
  id: "rt-111111111111",
  state: "STOPPED",
  account: "project-a",
  rootFolder: "projects/restart",
});

function card(panel: CyberShuttlePanel): HTMLElement {
  return panel.node.querySelector<HTMLElement>(".csRuntimeCard")!;
}

async function loaded(panel: CyberShuttlePanel): Promise<void> {
  await panel.signIn();
  await vi.waitFor(() => expect(card(panel)).not.toBeNull());
}

/** A loaded panel whose only runtime is the stopped one, ready to run again. */
async function started(startRuntime: unknown) {
  const api = {
    signIn: vi.fn(async () => undefined),
    listRuntimes: vi.fn(async () => runtimeListFixture([base])),
    listSshHosts: vi.fn(async () => []),
    startRuntime,
  };
  const panel = new CyberShuttlePanel(
    api as any,
    {
      currentRuntimeId: undefined,
      select: vi.fn(),
    } as any,
  );
  await loaded(panel);
  return { panel, api };
}

describe("runtime stop action", () => {
  it("publishes busy and error state for controller actions", async () => {
    const stopPending = Promise.withResolvers<IRuntime>();
    const failing = Promise.withResolvers<IRuntime>();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () =>
        runtimeListFixture([{ ...base, state: "READY" as const }]),
      ),
      listSshHosts: vi.fn(async () => []),
      stopRuntime: vi
        .fn()
        .mockReturnValueOnce(failing.promise)
        .mockReturnValueOnce(stopPending.promise),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);

    const failingStop = panel.stop(base.id);
    await vi.waitFor(() =>
      expect(api.stopRuntime).toHaveBeenCalledWith(base.id),
    );
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    failing.reject(new Error("Slurm cancellation failed."));
    await failingStop;
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    expect(panel.state.error).toBe("Slurm cancellation failed.");

    const stopping = panel.stop(base.id);
    await vi.waitFor(() => expect(api.stopRuntime).toHaveBeenCalledTimes(2));
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    stopPending.resolve({ ...base, state: "STOPPING" });
    await stopping;
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    panel.dispose();
  });

  it("runs a terminal runtime again in place", async () => {
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      startRuntime: vi.fn(async () => ({ ...base, state: "QUEUED" as const })),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);
    expect(card(panel).textContent).toContain("delta");
    expect(card(panel).textContent).not.toContain("Start");

    await panel.runAgain(base.id);
    expect(api.startRuntime).toHaveBeenCalledWith(base.id);
    expect(document.querySelector(".jp-Dialog")).toBeNull();
    expect(panel.state.runtimes.map((each) => each.id)).toEqual([base.id]);
    panel.dispose();
  });

  // A relaunch is starting from the click rather than from the poll that first
  // sees it: the poll releases a terminal card's Jupyter access and used to take
  // the spinner and the armed button with it, which is a second allocation.
  it("stays starting, busy and un-rearmed for the whole request", async () => {
    const pending = Promise.withResolvers<IRuntime>();
    const { panel, api } = await started(vi.fn(() => pending.promise));
    expect(card(panel).textContent).toContain("STOPPED");

    const running = panel.runAgain(base.id);
    await vi.waitFor(() => expect(api.startRuntime).toHaveBeenCalled());
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    expect(card(panel).textContent).toContain("SUBMITTING");
    expect(card(panel).textContent).not.toContain("STOPPED");

    await panel.runAgain(base.id);
    expect(api.startRuntime).toHaveBeenCalledTimes(1);

    pending.resolve({ ...base, state: "QUEUED" });
    await running;
    // The answer arrived later than the last read, so the card follows it.
    expect(card(panel).textContent).toContain("QUEUED");
    panel.dispose();
  });

  // A read that succeeded says nothing about an action that failed, and the
  // poll used to erase the reason within a second of it appearing.
  it("keeps a failed relaunch's reason on screen across a poll", async () => {
    const { panel } = await started(
      vi.fn(async () => {
        throw new Error("Slurm validation failed.");
      }),
    );
    await panel.runAgain(base.id);
    expect(panel.state.error).toBe("Slurm validation failed.");
    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm validation failed.");
    panel.dispose();
  });
});
