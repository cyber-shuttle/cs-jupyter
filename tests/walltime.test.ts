// A session only counts down once Slurm has started it; a queued session shows
// its full limit. The status bar item renders over a resolved promise, so tests
// drain the microtask queue directly rather than the clock.
import { describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import {
  LOW_TIME_MS,
  countsDown,
  formatRemaining,
  remainingMs,
} from "../src/dom";
import { WalltimeStatus } from "../src/metrics";
import { RunHistory } from "../src/RunHistory";
import { SessionDetail } from "../src/SessionDetail";
import { ControllerFake, sessionFixture as session, uiState } from "./fakes";

function remainingText(node: HTMLElement): string {
  const label = [...node.querySelectorAll(".csSessionDetailLabel")].find(
    (dt) => dt.textContent === "Remaining",
  );
  return label?.nextElementSibling?.textContent ?? "";
}

describe("walltime countdown", () => {
  it("counts from when Slurm started the job, not from when it was created", () => {
    const started = session({
      startedAt: "2030-01-01T00:00:00Z",
      resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    });
    expect(remainingMs(started, Date.parse("2030-01-01T00:45:00Z"))).toBe(
      15 * 60_000,
    );
  });

  it("shows the whole limit while the session has not started", () => {
    const full = session({
      resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    });
    expect(remainingMs(full, Date.now())).toBe(60 * 60_000);
  });

  it("never counts past zero", () => {
    const started = session({ startedAt: "2030-01-01T00:00:00Z" });
    expect(remainingMs(started, Date.parse("2030-01-01T09:00:00Z"))).toBe(0);
    expect(formatRemaining(-5000)).toBe("0m 0s");
  });

  it("reads as hours and minutes above an hour and minutes and seconds below", () => {
    expect(formatRemaining(90 * 60_000)).toBe("1h 30m");
    expect(formatRemaining(45_000)).toBe("0m 45s");
    expect(formatRemaining(LOW_TIME_MS)).toBe("10m 0s");
  });

  it("counts down only for a started session", () => {
    for (const [state, want] of [
      ["STARTING", true],
      ["READY", true],
      ["QUEUED", false],
      ["SUBMITTING", false],
      ["STOPPING", false],
      ["STOPPED", false],
      ["FAILED", false],
    ] as const) {
      expect(countsDown(session({ state }))).toBe(want);
    }
  });

  it("shows the same Remaining text in the session detail and run history", () => {
    vi.setSystemTime(Date.parse("2030-01-01T00:30:00Z"));
    const started = session({
      startedAt: "2030-01-01T00:00:00Z",
      resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    });
    const detail = new SessionDetail(
      new ControllerFake(uiState({ sessions: [started] })) as never,
      started.id,
    );
    const history = new RunHistory(
      new ControllerFake(uiState({ sessions: [started] })) as never,
    );
    expect(remainingText(detail.node)).toBe("30m 0s");
    expect(remainingText(detail.node)).toBe(remainingText(history.node));
    detail.dispose();
    history.dispose();
  });
});

describe("walltime status bar item", () => {
  const client = (value: ISession) =>
    ({ getSession: vi.fn(async () => value) }) as never;

  const settled = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  const hourJobItem = (overrides: Partial<ISession> = {}, leave?: () => void) =>
    new WalltimeStatus(
      client(
        session({
          startedAt: "2030-01-01T00:00:00Z",
          resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
          ...overrides,
        }),
      ),
      "s-012345abcdef",
      leave,
    );

  it("shows the remaining time for the session this page is attached to", async () => {
    vi.setSystemTime(Date.parse("2030-01-01T00:30:00Z"));
    const item = hourJobItem();
    await settled();
    expect(item.node.textContent).toContain("30m 0s");
    expect(item.isHidden).toBe(false);
    expect(item.hasClass("csWalltimeStatusLow")).toBe(false);
    item.dispose();
  });

  it("warns under ten minutes and says nothing at all once the session is over", async () => {
    vi.setSystemTime(Date.parse("2030-01-01T00:55:00Z"));
    const low = hourJobItem();
    await settled();
    expect(low.hasClass("csWalltimeStatusLow")).toBe(true);
    low.dispose();

    const over = hourJobItem({ state: "STOPPED" }, vi.fn());
    await settled();
    expect(over.isHidden).toBe(true);
    expect(over.node.textContent).toBe("");
    over.dispose();
  });

  it("queues the run and leaves at zero before the backend reports it stopped", async () => {
    sessionStorage.clear();
    vi.setSystemTime(Date.parse("2030-01-01T01:00:00Z"));
    const leave = vi.fn();
    const over = hourJobItem({ state: "READY" }, leave);
    await settled();
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBe(
      "s-012345abcdef/1",
    );
    expect(leave).toHaveBeenCalledOnce();
    over.dispose();
  });
});
