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

  // The card is starting from the click, not from the poll that first sees it,
  // so it never offers a second Run again over a request already in flight.
  it("shows a card being run again as starting for the whole request", async () => {
    const pending = Promise.withResolvers<IRuntime>();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      startRuntime: vi.fn(() => pending.promise),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);
    expect(card(panel).textContent).toContain("STOPPED");

    const running = panel.runAgain(base.id);
    await vi.waitFor(() =>
      expect(api.startRuntime).toHaveBeenCalledWith(base.id),
    );
    expect(panel.state.startingRuntimeIds.has(base.id)).toBe(true);
    expect(card(panel).textContent).toContain("SUBMITTING");
    expect(card(panel).textContent).not.toContain("STOPPED");

    pending.resolve({ ...base, state: "QUEUED" });
    await running;
    expect(panel.state.startingRuntimeIds.has(base.id)).toBe(false);
    // The action answered later than the last read, so the card follows the
    // answer rather than offering Run again again until the next poll.
    expect(card(panel).textContent).toContain("QUEUED");
    panel.dispose();
  });

  // Releasing a terminal card's Jupyter access happens on every poll, and used
  // to take the spinner off an action still running against that same card.
  it("keeps a relaunch busy across the polls that run during it", async () => {
    const pending = Promise.withResolvers<IRuntime>();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      startRuntime: vi.fn(() => pending.promise),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);

    const running = panel.runAgain(base.id);
    await vi.waitFor(() => expect(api.startRuntime).toHaveBeenCalled());
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.busyRuntimeIds.has(base.id)).toBe(true);
    expect(card(panel).textContent).toContain("SUBMITTING");

    // A button the poll re-armed is a second allocation, so the guard is on the
    // action rather than on whatever a view happens to render.
    await panel.runAgain(base.id);
    expect(api.startRuntime).toHaveBeenCalledTimes(1);

    pending.resolve({ ...base, state: "QUEUED" });
    await running;
    panel.dispose();
  });

  // A read that succeeded says nothing about an action that failed, and the
  // poll used to erase the reason within a second of it appearing.
  it("keeps a failed relaunch's reason on screen across a poll", async () => {
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
      startRuntime: vi.fn(async () => {
        throw new Error("Slurm validation failed.");
      }),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);

    await panel.runAgain(base.id);
    expect(panel.state.error).toBe("Slurm validation failed.");
    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm validation failed.");
    panel.dispose();
  });
});

// showDialog renders real buttons, so the confirmation is exercised the way a
// person answers it rather than stubbed away.
async function answerDialog(accept: boolean): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector(".jp-Dialog-button")).not.toBeNull(),
  );
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>(".jp-Dialog-button"),
  ];
  const target = buttons.find((button) =>
    accept
      ? button.classList.contains("jp-mod-accept")
      : button.classList.contains("jp-mod-reject"),
  );
  target!.click();
}

describe("runtime delete", () => {
  it("confirms, removes the card, and leaves the list alone when cancelled", async () => {
    const runtime = runtimeFixture({ state: "FAILED" });
    const api = {
      resumeSession: vi.fn(async () => undefined),
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([runtime])),
      listSshHosts: vi.fn(async () => []),
      deleteRuntime: vi.fn(async () => runtime),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      {
        currentRuntimeId: undefined,
        select: vi.fn(),
      } as any,
    );
    await vi.waitFor(() => expect(panel.state.runtimes.length).toBe(1));

    const cancelled = panel.remove(runtime.id);
    await answerDialog(false);
    await cancelled;
    expect(api.deleteRuntime).not.toHaveBeenCalled();
    expect(panel.state.runtimes.length).toBe(1);

    const accepted = panel.remove(runtime.id);
    await answerDialog(true);
    await accepted;
    expect(api.deleteRuntime).toHaveBeenCalledWith(runtime.id);
    expect(panel.state.runtimes.map((each) => each.id)).not.toContain(
      runtime.id,
    );
    panel.dispose();
  });
});
