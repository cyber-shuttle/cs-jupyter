// Exercises the panel's session poll loop: cadence, failure recovery, card and
// log replacement, and resume on reload. A tick firing while the previous read
// is outstanding must not stack a second one. A sign-out and sign-in cycle, or a
// rebuilt panel, must see the full list again, not a 304.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthInteractionRequiredError } from "../src/AuthClient";
import { ControlClient, UNCHANGED } from "../src/ControlClient";
import { jsonResponse, type IRun } from "../src/Common";
import { cacheSessionAccess } from "../src/session";
import { setActiveSessionId } from "../src/session";
import {
  accessFixture,
  controlFake,
  etagResponse,
  fakeAuth,
  panelFake,
  pollPanel,
  runFixture,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const session = sessionFixture({ state: "QUEUED" });

async function signingInWhileInFlight() {
  const inFlight =
    Promise.withResolvers<ReturnType<typeof sessionListFixture>>();
  const api = controlFake({
    listSessions: vi.fn(() => inFlight.promise),
  });
  const panel = panelFake(api);
  const signedIn = panel.signIn();
  await Promise.resolve();
  return { inFlight, api, panel, signedIn };
}

function cacheAccess(
  sessionId: string,
  seq: number,
  token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
): void {
  cacheSessionAccess(
    accessFixture(sessionId, seq, {
      jupyter: { ...accessFixture(sessionId, seq).jupyter, token },
    }),
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("session polling", () => {
  it("waits for an explicit sign-in before reading anything", async () => {
    const login = Promise.withResolvers<void>();
    const api = controlFake({
      signIn: vi.fn(() => login.promise),
      resumeSignIn: vi.fn(async () => {
        throw new Error("no session to resume");
      }),
    });
    const panel = panelFake(api);
    await Promise.resolve();
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.listSshHosts).not.toHaveBeenCalled();

    panel.header.node
      .querySelector<HTMLButtonElement>(".csSignInButton")!
      .click();
    const second = panel.signIn();
    expect(api.signIn).toHaveBeenCalledOnce();
    expect(panel.state.signingIn).toBe(true);
    login.resolve();
    await second;
    expect(panel.state.signedIn).toBe(true);
    expect(api.listSessions).toHaveBeenCalled();
    expect(api.listSshHosts).toHaveBeenCalledOnce();
    panel.dispose();
  });

  it("stops polling when the sign-in lapses and resumes after signing in again", async () => {
    const api = controlFake({
      listSessions: vi
        .fn()
        .mockRejectedValueOnce(new AuthInteractionRequiredError("expired"))
        .mockResolvedValue(sessionListFixture([session])),
    });
    const panel = panelFake(api);
    await panel.signIn();
    expect(panel.state.signedIn).toBe(false);
    expect(panel.state.updatesStatus).toContain("Sign in again");

    await panel.signIn();
    await pollPanel(panel);
    expect(panel.state.sessions.map((item) => item.id)).toEqual([session.id]);
    panel.dispose();
  });

  it("reports a failed poll without discarding what it already showed", async () => {
    const api = controlFake({
      listSessions: vi
        .fn()
        .mockResolvedValueOnce(sessionListFixture([session]))
        .mockRejectedValueOnce(new Error("control unreachable")),
    });
    const panel = panelFake(api);
    await panel.signIn();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Session updates unavailable.");
    expect(panel.state.sessions.map((item) => item.id)).toEqual([session.id]);
    panel.dispose();
  });

  it("runs one poll at a time and stops on disposal", async () => {
    const { inFlight, api, panel, signedIn } = await signingInWhileInFlight();
    const calls = api.listSessions.mock.calls.length;
    void pollPanel(panel);
    void pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(calls);
    inFlight.resolve(sessionListFixture([session]));
    await signedIn;

    panel.dispose();
    const afterDisposal = api.listSessions.mock.calls.length;
    await pollPanel(panel);
    expect(api.listSessions.mock.calls.length).toBe(afterDisposal);
  });

  it("replaces the whole card set and the whole log set on every read", async () => {
    const other = { ...session, id: "s-111111111111" };
    const api = controlFake();
    const panel = panelFake(api);
    await panel.signIn();

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

  it("clears terminal and superseded access without touching other sessions", async () => {
    const other = { ...session, id: "s-111111111111" };
    const api = controlFake();
    setActiveSessionId(session.id);
    const panel = panelFake(api);
    await panel.signIn();
    const key = `cybershuttle.session-access.v1.${session.id}`;
    const otherKey = `cybershuttle.session-access.v1.${other.id}`;
    const report = async (...sessions: object[]): Promise<void> => {
      api.listSessions.mockResolvedValue(sessionListFixture(sessions as any));
      await pollPanel(panel);
    };

    cacheAccess(session.id, session.seq);
    cacheAccess(other.id, other.seq, "B".repeat(43));
    window.localStorage.setItem(key, "unrelated-local-value");

    await report({ ...session, state: "READY" }, { ...other, state: "READY" });
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();

    await report(
      { ...session, state: "STARTING" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).not.toBeNull();

    await report(
      { ...session, state: "STOPPED" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();
    expect(window.localStorage.getItem(key)).toBe("unrelated-local-value");

    cacheAccess(session.id, session.seq);
    await report(
      { ...session, seq: 2, state: "READY" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();

    cacheAccess(session.id, session.seq);
    await report({ ...session, state: "FAILED" }, { ...other, state: "READY" });
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();
    panel.dispose();
    setActiveSessionId(undefined);
  });

  it("emits state when a poll drops a session no longer tracked, clearing its samples", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([session])),
      getSessionMetrics: vi.fn(async () => ({
        sessionId: session.id,
        samples: [{ at: "2026-01-01T00:00:00Z", memBytes: 1024 }],
      })),
    });
    const panel = panelFake(api);
    await panel.signIn();
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
    const { inFlight, panel, signedIn } = await signingInWhileInFlight();
    panel.signOut();
    inFlight.resolve(sessionListFixture([session]));
    await signedIn;
    await Promise.resolve();

    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
  });

  it("does not let runs or samples in flight when sign-out fired refill state", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([session])),
      listRuns: vi.fn(async (): Promise<IRun[]> => []),
      getSessionMetrics: vi.fn(
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
    await panel.signIn();

    const runsInFlight = Promise.withResolvers<IRun[]>();
    const samplesInFlight = Promise.withResolvers<{
      sessionId: string;
      samples: { at: string; memBytes: number }[];
    }>();
    api.listRuns.mockImplementation(() => runsInFlight.promise);
    api.getSessionMetrics.mockImplementation(() => samplesInFlight.promise);

    const polling = pollPanel(panel);
    await vi.waitFor(() =>
      expect(api.getSessionMetrics.mock.calls.length).toBeGreaterThan(1),
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
      const api = controlFake({
        listSessions: vi
          .fn()
          .mockResolvedValueOnce(sessionListFixture([ready]))
          .mockResolvedValue(UNCHANGED),
        getSessionAccess: vi
          .fn()
          .mockRejectedValueOnce(new Error("tunnel not up yet"))
          .mockResolvedValue(access),
      });
      const panel = panelFake(api);
      await panel.signIn();
      await vi.waitFor(() =>
        expect(api.getSessionAccess).toHaveBeenCalledTimes(1),
      );
      expect(panel.state.jupyterReady.has(ready.id)).toBe(false);
      expect(panel.state.error).toBe("tunnel not up yet");

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
        throw new Error("tunnel is not reachable yet");
      });
      const api = controlFake({
        listSessions: vi
          .fn()
          .mockResolvedValueOnce(sessionListFixture([ready]))
          .mockResolvedValue(UNCHANGED),
        getSessionAccess,
      });
      const panel = panelFake(api);
      await panel.signIn();
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

describe("conditional polling across sessions", () => {
  const etag = '"abc123"';
  const auth = { ...fakeAuth(), invalidateToken: vi.fn() };

  const conditionalControl = (sessions: unknown = [sessionFixture()]) =>
    new ControlClient(
      "https://control.example.edu/api/v1",
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
    const control = conditionalControl([{ state: "READY" }]);
    const panel = panelFake(control);
    await vi.waitFor(() =>
      expect(panel.state.updatesStatus).toBe("Session updates unavailable."),
    );
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Session updates unavailable.");
    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
  });

  it("shows the list again once whatever cached the ETag is gone", async () => {
    const control = conditionalControl();
    const panel = panelFake(control);
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(1));

    panel.signOut();
    expect(panel.state.sessions).toHaveLength(0);
    await panel.signIn();
    expect(panel.state.sessions.map((item) => item.id)).toEqual([
      "s-012345abcdef",
    ]);
    panel.dispose();

    const rebuilt = panelFake(control);
    await vi.waitFor(() => expect(rebuilt.state.sessions).toHaveLength(1));
    rebuilt.dispose();
  });
});

describe("session resume", () => {
  it("restores the credential and queued run report", async () => {
    sessionStorage.setItem("cybershuttle.run-report.v1", `${session.id}/1`);
    const api = controlFake({
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

  it("stays signed out when no credential survived the reload", async () => {
    const api = controlFake({
      resumeSignIn: vi.fn(async () => {
        throw new AuthInteractionRequiredError();
      }),
    });
    const panel = panelFake(api);
    await vi.waitFor(() => expect(api.resumeSignIn).toHaveBeenCalled());
    expect(panel.state.signedIn).toBe(false);
    expect(api.listSessions).not.toHaveBeenCalled();
    panel.dispose();
  });
});
