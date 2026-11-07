// A session only counts down once Slurm has started it; a queued session shows
// its full limit.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import {
  LOW_TIME_MS,
  countsDown,
  formatRemaining,
  remainingMs,
} from "../src/dom";
import { WalltimeStatus } from "../src/usage";
import { setActiveSession } from "../src/session";
import { RunHistory } from "../src/RunHistory";
import { SessionDetail } from "../src/SessionDetail";
import {
  PanelStateFake,
  SESSION_ID,
  sessionFixture as session,
  uiState,
} from "./fakes";

const NOW = Date.parse("2030-01-01T00:30:00Z");
const hourJob = {
  startedAt: Date.parse("2030-01-01T00:00:00Z"),
  deadline: Date.parse("2030-01-01T01:00:00Z"),
};

function remainingText(node: HTMLElement): string {
  const label = [...node.querySelectorAll(".csSessionDetailLabel")].find(
    (dt) => dt.textContent === "Remaining",
  );
  return label?.nextElementSibling?.textContent ?? "";
}

describe("walltime countdown", () => {
  it("counts down to the run's deadline", () =>
    expect(remainingMs(session({}, { deadline: NOW + 90_000 }), NOW)).toBe(
      90_000,
    ));

  it("shows the whole limit while the run has no deadline", () =>
    expect(remainingMs(session(), NOW)).toBe(30 * 60_000));

  it("never counts past zero", () => {
    expect(remainingMs(session({}, { deadline: NOW }), NOW + 60_000)).toBe(0);
    expect(formatRemaining(-5000)).toBe("0m 0s");
  });

  it("reads as hours and minutes above an hour and minutes and seconds below", () => {
    expect(formatRemaining(90 * 60_000)).toBe("1h 30m");
    expect(formatRemaining(45_000)).toBe("0m 45s");
    expect(formatRemaining(LOW_TIME_MS)).toBe("10m 0s");
  });

  it("counts down only for a started session", () => {
    for (const [state, want] of [
      ["CREATED", false],
      ["RUNNING", true],
      ["READY", true],
      ["SUBMITTED", false],
      ["CANCELLED", false],
      ["FAILED", false],
    ] as const) {
      expect(countsDown(session({ state }))).toBe(want);
    }
  });

  it("shows the same Remaining text in the session detail and run history", () => {
    vi.setSystemTime(NOW);
    const started = session(
      { resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 } },
      hourJob,
    );
    const detail = new SessionDetail(
      new PanelStateFake(uiState({ sessions: [started] })) as never,
      started.sessionId,
    );
    const history = new RunHistory(
      new PanelStateFake(uiState({ sessions: [started] })) as never,
    );
    expect(remainingText(detail.node)).toBe("30m 0s");
    expect(remainingText(detail.node)).toBe(remainingText(history.node));
    detail.dispose();
    history.dispose();
  });
});

describe("walltime status bar item", () => {
  afterEach(() => setActiveSession(undefined));

  const hourJobItem = (overrides: Partial<ISession> = {}) => {
    setActiveSession(SESSION_ID);
    const attached = session(
      {
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
        ...overrides,
      },
      hourJob,
    );
    return new WalltimeStatus(
      new PanelStateFake(uiState({ sessions: [attached] })) as never,
    );
  };

  it("shows the remaining time for the session this page is attached to", () => {
    vi.setSystemTime(NOW);
    const item = hourJobItem();
    expect(item.node.textContent).toContain("30m 0s");
    expect(item.isHidden).toBe(false);
    expect(item.hasClass("csWalltimeStatusLow")).toBe(false);
    item.dispose();
  });

  it("warns under ten minutes and says nothing at all once the session is over", () => {
    vi.setSystemTime(Date.parse("2030-01-01T00:55:00Z"));
    const low = hourJobItem();
    expect(low.hasClass("csWalltimeStatusLow")).toBe(true);
    low.dispose();

    const over = hourJobItem({ state: "CANCELLED" });
    expect(over.isHidden).toBe(true);
    expect(over.node.textContent).toBe("");
    over.dispose();
  });
});
