import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { ControlError } from "../src/ControlClient";
import {
  acceptDialog,
  controlFake,
  pollPanel,
  runtimeFixture,
  runtimeListFixture,
} from "./fakes";

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
  const api = controlFake({
    listRuntimes: vi.fn(async () => runtimeListFixture([base])),
    startRuntime,
  });
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
    const api = controlFake({
      listRuntimes: vi.fn(async () =>
        runtimeListFixture([{ ...base, state: "READY" as const }]),
      ),
      stopRuntime: vi
        .fn()
        .mockReturnValueOnce(failing.promise)
        .mockReturnValueOnce(stopPending.promise),
    });
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);

    const failingStop = panel.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopRuntime).toHaveBeenCalledWith(base.id),
    );
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    failing.reject(new Error("Slurm cancellation failed."));
    await failingStop;
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    expect(panel.state.error).toBe("Slurm cancellation failed.");

    const stopping = panel.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() => expect(api.stopRuntime).toHaveBeenCalledTimes(2));
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    stopPending.resolve({ ...base, state: "STOPPING" });
    await stopping;
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(false);
    panel.dispose();
  });

  // A relaunch is starting from the click rather than from the poll that first
  // sees it: the poll releases a terminal card's Jupyter access and used to take
  // the spinner and the armed button with it, which is a second allocation.
  it("stays starting, busy and un-rearmed for the whole request", async () => {
    const pending = Promise.withResolvers<IRuntime>();
    const { panel, api } = await started(vi.fn(() => pending.promise));
    expect(card(panel).textContent).toContain("STOPPED");

    expect(card(panel).textContent).not.toContain("Start");

    const running = panel.runAgain(base.id);
    await vi.waitFor(() =>
      expect(api.startRuntime).toHaveBeenCalledWith(base.id),
    );
    expect(document.querySelector(".jp-Dialog")).toBeNull();
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
    expect(panel.state.runtimes.map((each) => each.id)).toEqual([base.id]);
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

  // cs-control stops first and then refuses until the scheduler has released
  // the job, which for a live allocation is almost never the same instant.
  // Asking the owner to click Delete a second time would be asking them to
  // poll Slurm by hand.
  it("keeps a delete that the scheduler has not released yet, and finishes it", async () => {
    let state: IRuntime["state"] = "READY";
    const api = controlFake({
      listRuntimes: vi.fn(async () => runtimeListFixture([{ ...base, state }])),
      stopRuntime: vi.fn(async () => ({ ...base, state: "STOPPING" as const })),
      deleteRuntime: vi.fn(async () => {
        if (state !== "STOPPED") {
          throw new ControlError(
            "runtime_not_stopped",
            "runtime is still stopping",
          );
        }
        return { ...base, state: "STOPPED" as const };
      }),
    });
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);

    const removing = panel.remove(base.id);
    await acceptDialog();
    await removing;
    expect(api.deleteRuntime).toHaveBeenCalledTimes(1);
    // The card is still there, and so is the intent.
    expect(panel.state.runtimes.map((each) => each.id)).toEqual([base.id]);

    // Still not released: nothing is retried on a runtime Slurm still holds.
    await pollPanel(panel);
    expect(api.deleteRuntime).toHaveBeenCalledTimes(1);

    state = "STOPPED";
    await pollPanel(panel);
    await vi.waitFor(() => expect(api.deleteRuntime).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(panel.state.runtimes).toHaveLength(0));
    panel.dispose();
  });
});
