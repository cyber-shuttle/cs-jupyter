// Exercises the panel's session poll loop: cadence, failure recovery, session and
// log replacement, and resume on reload. A tick firing while the previous read
// is outstanding must not stack a second one. A panel rebuilt after sign-out
// must see the full list again, not a 304.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthInteractionRequiredError } from "../src/AuthClient";
import { PlaneClient, UNCHANGED } from "../src/PlaneClient";
import { jsonResponse, type IRun } from "../src/Common";
import { setActiveSession } from "../src/session";
import {
  accessFixture,
  planeFake,
  etagResponse,
  fakeAuth,
  panelFake,
  pollPanel,
  runFixture,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const session = sessionFixture({ state: "QUEUED" });
const starting = { ...session, state: "STARTING" as const };

async function resumingWhileInFlight() {
  const inFlight =
    Promise.withResolvers<ReturnType<typeof sessionListFixture>>();
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
    expect(api.listSshHosts).not.toHaveBeenCalled();
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
        .mockResolvedValueOnce(sessionListFixture([session]))
        .mockRejectedValueOnce(new Error("cs-plane unreachable")),
    });
    const panel = panelFake(api);
    await panel.restored;
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Session updates unavailable.");
    expect(panel.state.sessions.map((item) => item.id)).toEqual([session.id]);
    panel.dispose();
  });

  it("runs one poll at a time and stops on disposal", async () => {
    const { inFlight, api, panel, resumed } = await resumingWhileInFlight();
    const calls = api.listSessions.mock.calls.length;
    void pollPanel(panel);
    void pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(calls);
    inFlight.resolve(sessionListFixture([session]));
    await resumed;

    panel.dispose();
    const afterDisposal = api.listSessions.mock.calls.length;
    await pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(afterDisposal);
  });

  it("replaces the whole session set and the whole log set on every read", async () => {
    const other = { ...session, id: "s-111111111111" };
    const api = planeFake();
    const panel = panelFake(api);
    await panel.restored;

    api.listSessions.mockResolvedValue(
      sessionListFixture(
        [session, other],
        [
          {
            sessionId: session.id,
            lines: [
              {
                stream: "status",
                text: "queued",
                at: "2026-01-01T00:00:00Z",
              },
            ],
          },
        ],
      ),
    );
    await pollPanel(panel);
    expect(panel.state.sessions.map((item) => item.id)).toEqual([
      session.id,
      other.id,
    ]);
    expect(panel.state.logs.get(session.id)?.lines).toHaveLength(1);

    api.listSessions.mockResolvedValue(sessionListFixture([other]));
    await pollPanel(panel);
    expect(panel.state.sessions.map((item) => item.id)).toEqual([other.id]);
    expect(panel.state.logs.has(session.id)).toBe(false);
    panel.dispose();
  });

  it("leaves the page with a run report once the attached session ends", async () => {
    const api = planeFake();
    setActiveSession({ id: session.id, seq: session.seq });
    const panel = panelFake(api);
    await panel.restored;
    api.listSessions.mockResolvedValue(
      sessionListFixture([{ ...session, state: "STOPPED" }]),
    );
    await pollPanel(panel);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBe(
      `${session.id}/${session.seq}`,
    );
    panel.dispose();
    setActiveSession(undefined);
  });

  it("leaves the page once the attached run's walltime runs out, with no change in the list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sessionStorage.removeItem("cybershuttle.run-report.v1");
    const running = {
      ...session,
      state: "READY" as const,
      startedAt: new Date().toISOString(),
      resources: { ...session.resources, wallMinutes: 1 },
    };
    const api = planeFake();
    setActiveSession({ id: running.id, seq: running.seq });
    api.listSessions.mockResolvedValue(sessionListFixture([running]));
    const panel = panelFake(api);
    await panel.restored;
    await pollPanel(panel);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBeNull();

    vi.setSystemTime(Date.now() + 61_000);
    await pollPanel(panel);
    expect(sessionStorage.getItem("cybershuttle.run-report.v1")).toBe(
      `${running.id}/${running.seq}`,
    );
    panel.dispose();
    setActiveSession(undefined);
    vi.useRealTimers();
  });

  it("emits state when a poll drops a session no longer tracked, clearing its samples", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([starting])),
      getSessionUsage: vi.fn(async () => ({
        sessionId: session.id,
        samples: [{ at: "2026-01-01T00:00:00Z", memBytes: 1024 }],
      })),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.samples.get(session.id)).toBeDefined(),
    );

    api.listSessions.mockResolvedValue(sessionListFixture([]));
    let emitted = false;
    panel.stateChanged.connect(() => {
      emitted = true;
    });
    await pollPanel(panel);

    expect(panel.state.samples.has(session.id)).toBe(false);
    expect(emitted).toBe(true);
    panel.dispose();
  });
});

describe("sign-out during an in-flight poll", () => {
  it("does not let a listSessions read that was already in flight refill state after sign-out", async () => {
    const { inFlight, panel, resumed } = await resumingWhileInFlight();
    panel.signOut();
    inFlight.resolve(sessionListFixture([session]));
    await resumed;
    await Promise.resolve();

    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
  });

  it("does not let runs or samples in flight when sign-out fired refill state", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([starting])),
      listRuns: vi.fn(async (): Promise<IRun[]> => []),
      getSessionUsage: vi.fn(
        async (): Promise<{
          sessionId: string;
          samples: { at: string; memBytes: number }[];
        }> => ({
          sessionId: session.id,
          samples: [],
        }),
      ),
    });
    const panel = panelFake(api);
    await panel.restored;

    const runsInFlight = Promise.withResolvers<IRun[]>();
    const samplesInFlight = Promise.withResolvers<{
      sessionId: string;
      samples: { at: string; memBytes: number }[];
    }>();
    api.listRuns.mockImplementation(() => runsInFlight.promise);
    api.getSessionUsage.mockImplementation(() => samplesInFlight.promise);

    const polling = pollPanel(panel);
    await vi.waitFor(() =>
      expect(api.getSessionUsage.mock.calls.length).toBeGreaterThan(1),
    );
    panel.signOut();
    runsInFlight.resolve([runFixture({ sessionId: session.id })]);
    samplesInFlight.resolve({
      sessionId: session.id,
      samples: [{ at: "2026-01-01T00:00:00Z", memBytes: 1024 }],
    });
    await polling;
    await Promise.resolve();

    expect(panel.state.runs).toHaveLength(0);
    expect(panel.state.samples.has(session.id)).toBe(false);
    panel.dispose();
  });
});

describe("polling an unchanged list", () => {
  const ready = sessionFixture();
  const access = accessFixture(ready.id, ready.seq);

  it("retries an access read that failed while cs-plane reports no change", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const api = planeFake({
        listSessions: vi
          .fn()
          .mockResolvedValueOnce(sessionListFixture([ready]))
          .mockResolvedValue(UNCHANGED),
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
      expect(panel.state.jupyterReady.has(ready.id)).toBe(false);
      expect(panel.state.error).toBe("Jupyter not up yet");

      now.mockReturnValue(60_000);
      await pollPanel(panel);
      await vi.waitFor(() =>
        expect(panel.state.jupyterReady.has(ready.id)).toBe(true),
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
        listSessions: vi
          .fn()
          .mockResolvedValueOnce(sessionListFixture([ready]))
          .mockResolvedValue(UNCHANGED),
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

describe("run history reads", () => {
  it("reads runs only when the list changes or Run History is open", async () => {
    const api = planeFake({
      listSessions: vi
        .fn()
        .mockResolvedValueOnce(sessionListFixture([session]))
        .mockResolvedValue(UNCHANGED),
      listRuns: vi.fn(async (): Promise<IRun[]> => []),
    });
    const panel = panelFake(api);
    await panel.restored;
    await pollPanel(panel);
    expect(api.listRuns).toHaveBeenCalledOnce();
    panel.modals.runHistoryOpen = true;
    await pollPanel(panel);
    expect(api.listRuns).toHaveBeenCalledTimes(2);
    panel.dispose();
  });
});

describe("conditional polling across sessions", () => {
  const etag = '"abc123"';
  const auth = { ...fakeAuth(), invalidateToken: vi.fn() };

  const conditionalPlane = (sessions: unknown = [sessionFixture()]) =>
    new PlaneClient(
      "https://plane.example.edu/api/v1",
      auth as any,
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith("/hosts")) {
          return jsonResponse({ hosts: [] });
        }
        if (new Headers(init?.headers).get("If-None-Match") === etag) {
          return new Response(null, { status: 304 });
        }
        return etagResponse({ sessions, logs: [] }, etag);
      }) as any,
    );

  it("keeps reporting failure instead of going silently blank after an invalid, ETagged list", async () => {
    const plane = conditionalPlane([{ state: "READY" }]);
    const panel = panelFake(plane);
    await vi.waitFor(() =>
      expect(panel.state.updatesStatus).toBe("Session updates unavailable."),
    );
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Session updates unavailable.");
    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
  });

  it("shows the list again once whatever cached the ETag is gone", async () => {
    const plane = conditionalPlane();
    const panel = panelFake(plane);
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(1));

    panel.signOut();
    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();

    const rebuilt = panelFake(plane);
    await vi.waitFor(() => expect(rebuilt.state.sessions).toHaveLength(1));
    rebuilt.dispose();
  });
});

describe("session resume", () => {
  it("restores the credential and queued run report", async () => {
    sessionStorage.setItem("cybershuttle.run-report.v1", `${session.id}/1`);
    const api = planeFake({
      resumeSignIn: vi.fn(async () => undefined),
    });
    const panel = panelFake(api);
    const open = vi.spyOn(panel.modals, "openRunHistory").mockResolvedValue();
    await vi.waitFor(() => expect(panel.state.signedIn).toBe(true));
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(`${session.id}/1`);
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
