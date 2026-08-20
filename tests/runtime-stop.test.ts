import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { runtimeFixture, runtimeListFixture } from "./fakes";

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

  // A terminal allocation is gone, so the only way to run it again is to create
  // another like it. The card must not offer to resume the dead one.
  it("offers no resume action on a terminal runtime", async () => {
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture([base])),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = new CyberShuttlePanel(
      api as any,
      { currentRuntimeId: undefined, select: vi.fn() } as any,
    );
    await loaded(panel);
    expect(card(panel).textContent).toContain("projects/restart");
    expect(card(panel).textContent).not.toContain("Start");
    expect((api as any).startRuntime).toBeUndefined();
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
