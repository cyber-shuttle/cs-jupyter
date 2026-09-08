import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
import {
  LOW_TIME_MS,
  countsDown,
  formatRemaining,
  remainingMs,
} from "../src/walltime";

const runtime = (over: Partial<IRuntime> = {}): IRuntime =>
  ({
    id: "rt-012345abcdef",
    generation: "g-0123456789abcdef",
    state: "READY",
    sshHost: "delta",
    partition: "cpu",
    rootFolder: "$HOME/project",
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    createdAt: "2030-01-01T00:00:00Z",
    updatedAt: "2030-01-01T00:00:00Z",
    ...over,
  }) as IRuntime;

describe("walltime countdown", () => {
  it("counts from when Slurm started the job, not from when it was created", () => {
    const started = runtime({ startedAt: "2030-01-01T00:00:00Z" });
    expect(remainingMs(started, Date.parse("2030-01-01T00:45:00Z"))).toBe(
      15 * 60_000,
    );
  });

  // A queued allocation is waiting under no deadline: the whole limit is still
  // ahead of it, which is what is actually left.
  it("shows the whole limit while the allocation has not started", () => {
    expect(remainingMs(runtime(), Date.now())).toBe(60 * 60_000);
  });

  it("never counts past zero", () => {
    const started = runtime({ startedAt: "2030-01-01T00:00:00Z" });
    expect(remainingMs(started, Date.parse("2030-01-01T09:00:00Z"))).toBe(0);
    expect(formatRemaining(-5000)).toBe("0m 0s");
  });

  it("reads as hours and minutes above an hour and minutes and seconds below", () => {
    expect(formatRemaining(90 * 60_000)).toBe("1h 30m");
    expect(formatRemaining(45_000)).toBe("0m 45s");
    expect(formatRemaining(LOW_TIME_MS)).toBe("10m 0s");
  });

  // Only a started allocation is under a deadline; the rest are waiting or over.
  it("counts down only for a started allocation", () => {
    for (const [state, want] of [
      ["STARTING", true],
      ["READY", true],
      ["QUEUED", false],
      ["SUBMITTING", false],
      ["STOPPING", false],
      ["STOPPED", false],
      ["FAILED", false],
    ] as const) {
      expect(countsDown(runtime({ state }))).toBe(want);
    }
  });
});

describe("walltime status bar item", () => {
  const client = (value: IRuntime) =>
    ({ getRuntime: vi.fn(async () => value) }) as never;

  // The read is a resolved promise, so its effect lands on the microtask queue.
  // Polling the wall clock for it only made this slow, and flaky under load.
  const settled = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("shows the remaining time for the runtime this page is attached to", async () => {
    const { WalltimeStatus } = await import("../src/walltime-status");
    vi.setSystemTime(Date.parse("2030-01-01T00:30:00Z"));
    const item = new WalltimeStatus(
      client(runtime({ startedAt: "2030-01-01T00:00:00Z" })),
      "rt-012345abcdef",
    );
    await settled();
    expect(item.node.textContent).toContain("30m 0s");
    expect(item.isHidden).toBe(false);
    expect(item.hasClass("csWalltimeStatusLow")).toBe(false);
    item.dispose();
  });

  it("warns under ten minutes and says nothing at all once the runtime is over", async () => {
    const { WalltimeStatus } = await import("../src/walltime-status");
    vi.setSystemTime(Date.parse("2030-01-01T00:55:00Z"));
    const low = new WalltimeStatus(
      client(runtime({ startedAt: "2030-01-01T00:00:00Z" })),
      "rt-012345abcdef",
    );
    await settled();
    expect(low.hasClass("csWalltimeStatusLow")).toBe(true);
    low.dispose();

    const over = new WalltimeStatus(
      client(runtime({ state: "STOPPED", startedAt: "2030-01-01T00:00:00Z" })),
      "rt-012345abcdef",
    );
    await settled();
    expect(over.isHidden).toBe(true);
    expect(over.node.textContent).toBe("");
    over.dispose();
  });
});
