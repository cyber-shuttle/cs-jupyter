// Exercises the panel's session poll loop: cadence, failure recovery, session and
// log replacement, and resume on reload. A tick firing while the previous read
// is outstanding must not stack a second one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthInteractionRequiredError } from "../src/AuthClient";
import type { ISession, IUsageReport } from "../src/Common";
import { setActiveSession } from "../src/session";
import {
  accessFixture,
  planeFake,
  logTail,
  panelFake,
  pollPanel,
  PROCESS_ID,
  processId,
  SESSION_ID,
  sessionFixture,
  sessionId,
} from "./fakes";

const session = sessionFixture({ state: "SUBMITTED" });
const ready = sessionFixture();

async function resumingWhileInFlight() {
  const inFlight = Promise.withResolvers<ISession[]>();
  const api = planeFake({
    listSessions: vi.fn(() => inFlight.promise),
  });
  const panel = panelFake(api);
  await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalled());
  return { inFlight, api, panel, resumed: panel.restored };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("session polling", () => {
  it("waits for an explicit sign-in, which leaves the page, before reading anything", async () => {
    const signIn = Promise.withResolvers<void>();
    const api = planeFake({
      signIn: vi.fn(() => signIn.promise),
      resumeSignIn: vi.fn(async () => {
        throw new AuthInteractionRequiredError();
      }),
    });
    const panel = panelFake(api);
    await panel.restored;
    expect(panel.state.error).toBe("");

    panel.header.node
      .querySelector<HTMLButtonElement>(".csSignInButton")!
      .click();
    const second = panel.signIn();
    expect(api.signIn).toHaveBeenCalledOnce();
    expect(panel.state.signingIn).toBe(true);
    signIn.resolve();
    await second;
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.listConfigs).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("stops polling when the sign-in lapses", async () => {
    const api = planeFake({
      listSessions: vi
        .fn()
        .mockRejectedValueOnce(new AuthInteractionRequiredError("expired")),
    });
    const panel = panelFake(api);
    await panel.restored;
    expect(panel.state.signedIn).toBe(false);
    expect(panel.state.updatesStatus).toContain("Sign in again");
    panel.dispose();
  });

  it("reports a failed poll without discarding what it already showed", async () => {
    const api = planeFake({
      listSessions: vi
        .fn()
        .mockResolvedValueOnce([session])
        .mockRejectedValueOnce(new Error("CyberShuttle API unreachable")),
    });
    const panel = panelFake(api);
    await panel.restored;
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Session updates unavailable.");
    expect(panel.state.sessions.map((item) => item.sessionId)).toEqual([
      SESSION_ID,
    ]);
    panel.dispose();
  });

  it("runs one poll at a time and stops on disposal", async () => {
    const { inFlight, api, panel, resumed } = await resumingWhileInFlight();
    const calls = api.listSessions.mock.calls.length;
    void pollPanel(panel);
    void pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(calls);
    inFlight.resolve([session]);
    await resumed;

    panel.dispose();
    const afterDisposal = api.listSessions.mock.calls.length;
    await pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(afterDisposal);
  });

  it("replaces the whole session set on every read, reading logs only for open views and once more after a session ends", async () => {
    const other = sessionFixture(
      { sessionId: sessionId(2), state: "SUBMITTED" },
      { processId: processId(2) },
    );
    const api = planeFake({
      getSessionLogs: vi.fn(async (id: string) =>
        logTail(
          id,
          id === PROCESS_ID
            ? [{ text: "queued", at: "2026-01-01T00:00:00Z" }]
            : [],
        ),
      ),
    });
    const panel = panelFake(api);
    await panel.restored;
    panel.logWatchers.add(new Set([PROCESS_ID]));

    api.listSessions.mockResolvedValue([session, other]);
    await pollPanel(panel);
    expect(panel.state.sessions.map((item) => item.sessionId)).toEqual([
      SESSION_ID,
      other.sessionId,
    ]);
    expect(panel.state.logs.get(PROCESS_ID)?.lines).toHaveLength(1);
    expect(api.getSessionLogs).not.toHaveBeenCalledWith(processId(2));

    api.listSessions.mockResolvedValue([other]);
    api.getSessionLogs.mockClear();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.sessions.map((item) => item.sessionId)).toEqual([
      other.sessionId,
    ]);
    expect(api.getSessionLogs.mock.calls).toEqual([[PROCESS_ID]]);
    expect(panel.state.logs.get(PROCESS_ID)?.lines).toHaveLength(1);
    panel.dispose();
  });

  it("leaves the page with a run report once the attached session ends", async () => {
    const api = planeFake();
    api.listSessions.mockResolvedValue([ready]);
    setActiveSession(SESSION_ID);
    const panel = panelFake(api);
    await panel.restored;
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBeNull();
    api.listSessions.mockResolvedValue([
      sessionFixture(
        { state: "CANCELLED", live: false },
        { state: "CANCELLED" },
      ),
    ]);
    await pollPanel(panel);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBe(
      PROCESS_ID,
    );
    panel.dispose();
    setActiveSession(undefined);
  });

  it("leaves the page without a run report once the attached session is gone", async () => {
    const api = planeFake();
    setActiveSession(SESSION_ID);
    const panel = panelFake(api);
    await panel.restored;
    expect((panel as any)._leaveIfEnded()).toBe(true);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBeNull();
    panel.dispose();
    setActiveSession(undefined);
  });

  it("drops Jupyter readiness when the current run changes between polls", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [
        sessionFixture({}, { processId: processId(1) }),
      ]),
      getSessionUsage: vi.fn(async () => ({ memBytes: 1024 })),
    });
    const panel = panelFake(api);
    const watched = new Set([processId(1)]);
    panel.logWatchers.add(watched);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.jupyterReady.has(SESSION_ID)).toBe(true),
    );
    await pollPanel(panel);
    expect(panel.state.samples.has(SESSION_ID)).toBe(true);
    expect(panel.state.logs.has(processId(1))).toBe(true);

    api.listSessions.mockResolvedValue([
      sessionFixture({}, { processId: processId(2) }),
    ]);
    watched.clear();
    watched.add(processId(2));
    await pollPanel(panel);
    expect(panel.state.samples.has(SESSION_ID)).toBe(false);
    expect(panel.state.logs.has(processId(1))).toBe(false);
    await vi.waitFor(() =>
      expect(api.getSessionAccess.mock.calls).toEqual([
        [processId(1)],
        [processId(2)],
      ]),
    );
    panel.dispose();
  });

  it("stamps each usage report and keeps the last 20 as a window", async () => {
    let memBytes = 0;
    const api = planeFake({
      listSessions: vi.fn(async () => [ready]),
      getSessionUsage: vi.fn(async () => ({ memBytes: ++memBytes })),
    });
    const panel = panelFake(api);
    await panel.restored;
    for (let i = 0; i < 25; i++) await pollPanel(panel);
    const samples = panel.state.samples.get(SESSION_ID)!;
    expect(samples).toHaveLength(20);
    expect(samples[19].memBytes).toBe(memBytes);
    expect(samples[0].memBytes).toBe(memBytes - 19);
    expect(samples.every((each) => typeof each.at === "number")).toBe(true);
    panel.dispose();
  });

  it("emits state when a poll drops a session no longer tracked, clearing its samples", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [ready]),
      getSessionUsage: vi.fn(async () => ({ memBytes: 1024 })),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(async () => {
      await pollPanel(panel);
      expect(panel.state.samples.get(SESSION_ID)).toBeDefined();
    });

    api.listSessions.mockResolvedValue([]);
    let emitted = false;
    panel.stateChanged.connect(() => {
      emitted = true;
    });
    await pollPanel(panel);

    expect(panel.state.samples.has(SESSION_ID)).toBe(false);
    expect(emitted).toBe(true);
    panel.dispose();
  });
});

describe("sign-out during an in-flight poll", () => {
  it("does not let a listSessions read that was already in flight refill state after sign-out", async () => {
    const { inFlight, panel, resumed } = await resumingWhileInFlight();
    panel.signOut();
    inFlight.resolve([session]);
    await resumed;
    await Promise.resolve();

    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
  });

  it("does not let logs or samples in flight when sign-out fired refill state", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [ready]),
      getSessionUsage: vi.fn(async (): Promise<IUsageReport> => ({})),
    });
    const panel = panelFake(api);
    await panel.restored;
    panel.logWatchers.add(new Set([PROCESS_ID]));
    await vi.waitFor(() =>
      expect(panel.state.jupyterReady.has(SESSION_ID)).toBe(true),
    );

    const logsInFlight = Promise.withResolvers<ReturnType<typeof logTail>>();
    const samplesInFlight = Promise.withResolvers<IUsageReport>();
    api.getSessionLogs.mockImplementation(() => logsInFlight.promise);
    api.getSessionUsage.mockImplementation(() => samplesInFlight.promise);

    const polling = pollPanel(panel);
    await vi.waitFor(() => expect(api.getSessionUsage).toHaveBeenCalled());
    panel.signOut();
    logsInFlight.resolve(
      logTail(PROCESS_ID, [{ text: "queued", at: "2026-01-01T00:00:00Z" }]),
    );
    samplesInFlight.resolve({ memBytes: 1024 });
    await polling;
    await Promise.resolve();

    expect(panel.state.logs.size).toBe(0);
    expect(panel.state.samples.has(SESSION_ID)).toBe(false);
    panel.dispose();
  });
});

describe("polling access", () => {
  const access = accessFixture(PROCESS_ID);

  it("retries an access read that failed on an earlier poll", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const api = planeFake({
        listSessions: vi.fn(async () => [ready]),
        getSessionAccess: vi
          .fn()
          .mockRejectedValueOnce(new Error("Jupyter not up yet"))
          .mockResolvedValue(access),
      });
      const panel = panelFake(api);
      await panel.restored;
      await vi.waitFor(() =>
        expect(api.getSessionAccess).toHaveBeenCalledTimes(1),
      );
      expect(panel.state.jupyterReady.has(SESSION_ID)).toBe(false);
      expect(panel.state.error).toBe("Jupyter not up yet");

      now.mockReturnValue(60_000);
      await pollPanel(panel);
      await vi.waitFor(() =>
        expect(panel.state.jupyterReady.has(SESSION_ID)).toBe(true),
      );
      expect(panel.state.error).toBe("");
      panel.dispose();
    } finally {
      now.mockRestore();
    }
  });

  it("backs off a repeatedly refused access read instead of retrying every poll", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const getSessionAccess = vi.fn(async () => {
        throw new Error("Jupyter is not reachable yet");
      });
      const api = planeFake({
        listSessions: vi.fn(async () => [ready]),
        getSessionAccess,
      });
      const panel = panelFake(api);
      await panel.restored;
      for (let i = 0; i < 10; i++) {
        now.mockReturnValue(i * 1000);
        await pollPanel(panel);
      }
      expect(getSessionAccess.mock.calls.length).toBeLessThanOrEqual(4);
      panel.dispose();
    } finally {
      now.mockRestore();
    }
  });
});

describe("run reports", () => {
  it("reads a finished run's log once, when its report is opened", async () => {
    const run = processId(7);
    const ended = sessionFixture(
      { sessionId: sessionId(7), state: "CANCELLED", live: false },
      { processId: run, state: "CANCELLED" },
    );
    const api = planeFake({
      listSessions: vi.fn(async () => [ended]),
      getSessionLogs: vi.fn(async (id: string) =>
        logTail(id, [{ text: "ended", at: "2030-01-01T01:00:00Z" }]),
      ),
    });
    const panel = panelFake(api);
    await panel.restored;
    expect(api.getSessionLogs).not.toHaveBeenCalled();

    panel.logWatchers.add(new Set([run]));
    await pollPanel(panel);
    await pollPanel(panel);
    expect(api.getSessionLogs).toHaveBeenCalledOnce();
    expect(panel.state.logs.get(run)?.lines).toEqual([
      { text: "ended", at: "2030-01-01T01:00:00Z" },
    ]);
    panel.dispose();
  });
});

describe("session resume", () => {
  it("restores the credential and queued run report", async () => {
    sessionStorage.setItem("cybershuttle.run-report.v1", PROCESS_ID);
    const api = planeFake({
      resumeSignIn: vi.fn(async () => undefined),
    });
    const panel = panelFake(api);
    const open = vi.spyOn(panel.modals, "openRunHistory").mockResolvedValue();
    await vi.waitFor(() => expect(panel.state.signedIn).toBe(true));
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(PROCESS_ID);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBeNull();
    panel.dispose();
  });

  it("reports a failed sign-in callback", async () => {
    const api = planeFake({
      resumeSignIn: vi.fn(async () => {
        throw new Error("Sign-in state did not match; try signing in again.");
      }),
    });
    const panel = panelFake(api);
    await panel.restored;
    expect(panel.state.error).toContain("Sign-in state did not match");
    panel.dispose();
  });
});
