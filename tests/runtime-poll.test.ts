import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthInteractionRequiredError } from "../src/AuthClient";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { cacheRuntimeAccess } from "../src/runtime-access";
import { pollPanel, runtimeFixture, runtimeListFixture } from "./fakes";

const runtime = runtimeFixture({ state: "QUEUED" });

function cacheAccess(
  runtimeId: string,
  generation: string,
  capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
): void {
  cacheRuntimeAccess({
    runtimeId,
    generation,
    expiresAt: "2030-01-01T00:00:00Z",
    jupyter: { uri: "https://31002.use.devtunnels.ms/", token: capability },
  });
}

function panelFor(api: object, currentRuntimeId?: string): CyberShuttlePanel {
  return new CyberShuttlePanel(
    api as any,
    {
      currentRuntimeId,
      select: vi.fn(),
    } as any,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("runtime polling", () => {
  it("waits for an explicit sign-in before reading anything", async () => {
    const login = Promise.withResolvers<void>();
    const api = {
      signIn: vi.fn(() => login.promise),
      listRuntimes: vi.fn(async () => runtimeListFixture()),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    await Promise.resolve();
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.listRuntimes).not.toHaveBeenCalled();
    expect(api.listSshHosts).not.toHaveBeenCalled();

    panel.node.querySelector<HTMLButtonElement>(".csSignInButton")!.click();
    const second = panel.signIn();
    expect(api.signIn).toHaveBeenCalledOnce();
    expect(panel.state.signingIn).toBe(true);
    login.resolve();
    await second;
    expect(panel.state.signedIn).toBe(true);
    expect(api.listRuntimes).toHaveBeenCalled();
    expect(api.listSshHosts).toHaveBeenCalledOnce();
    panel.dispose();
  });

  it("stops polling when the session lapses and resumes after signing in again", async () => {
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi
        .fn()
        .mockRejectedValueOnce(new AuthInteractionRequiredError("expired"))
        .mockResolvedValue(runtimeListFixture([runtime])),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    // Signing in starts the first poll, and that is the one that lapses.
    await panel.signIn();
    expect(panel.state.authRequired).toBe(true);
    expect(panel.state.updatesStatus).toContain("Sign in again");

    await panel.signIn();
    await pollPanel(panel);
    expect(panel.state.authRequired).toBe(false);
    expect(panel.state.runtimes.map((item) => item.id)).toEqual([runtime.id]);
    panel.dispose();
  });

  it("reports a failed poll without discarding what it already showed", async () => {
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi
        .fn()
        .mockResolvedValueOnce(runtimeListFixture([runtime]))
        .mockRejectedValueOnce(new Error("control unreachable")),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    await panel.signIn();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(panel.state.updatesStatus).toBe("Runtime updates unavailable.");
    expect(panel.state.runtimes.map((item) => item.id)).toEqual([runtime.id]);
    panel.dispose();
  });

  it("runs one poll at a time and stops on disposal", async () => {
    const inFlight =
      Promise.withResolvers<ReturnType<typeof runtimeListFixture>>();
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(() => inFlight.promise),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    const signedIn = panel.signIn();
    await Promise.resolve();
    const calls = api.listRuntimes.mock.calls.length;
    // A tick that fires while the previous read is outstanding must not stack a
    // second one: the browser would otherwise queue reads it cannot keep up with.
    void pollPanel(panel);
    void pollPanel(panel);
    expect(api.listRuntimes.mock.calls.length).toBe(calls);
    inFlight.resolve(runtimeListFixture([runtime]));
    await signedIn;

    panel.dispose();
    const afterDisposal = api.listRuntimes.mock.calls.length;
    await pollPanel(panel);
    expect(api.listRuntimes.mock.calls.length).toBe(afterDisposal);
  });

  it("replaces the whole card set and the whole log set on every read", async () => {
    const other = { ...runtime, id: "rt-111111111111" };
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture()),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    await panel.signIn();

    api.listRuntimes.mockResolvedValue(
      runtimeListFixture(
        [runtime, other],
        [
          {
            runtimeId: runtime.id,
            lines: [{ stream: "status", text: "queued" }],
          },
        ],
      ),
    );
    await pollPanel(panel);
    expect(panel.state.runtimes.map((item) => item.id)).toEqual([
      runtime.id,
      other.id,
    ]);
    expect(panel.state.logs.get(runtime.id)?.lines).toHaveLength(1);

    // A runtime that stops being reported takes its tail with it.
    api.listRuntimes.mockResolvedValue(runtimeListFixture([other]));
    await pollPanel(panel);
    expect(panel.state.runtimes.map((item) => item.id)).toEqual([other.id]);
    expect(panel.state.logs.has(runtime.id)).toBe(false);
    panel.dispose();
  });

  it("clears terminal and superseded access without touching other runtimes", async () => {
    const other = { ...runtime, id: "rt-111111111111" };
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(async () => runtimeListFixture()),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api, runtime.id);
    await panel.signIn();
    const key = `cybershuttle.runtime-access.v1.${runtime.id}`;
    const otherKey = `cybershuttle.runtime-access.v1.${other.id}`;
    const report = async (...runtimes: object[]): Promise<void> => {
      api.listRuntimes.mockResolvedValue(runtimeListFixture(runtimes as any));
      await pollPanel(panel);
    };

    cacheAccess(runtime.id, runtime.generation);
    cacheAccess(other.id, other.generation, "B".repeat(43));
    window.localStorage.setItem(key, "unrelated-local-value");

    await report({ ...runtime, state: "READY" }, { ...other, state: "READY" });
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();

    await report(
      { ...runtime, state: "STARTING" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).not.toBeNull();

    await report(
      { ...runtime, state: "STOPPED" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();
    expect(window.localStorage.getItem(key)).toBe("unrelated-local-value");

    cacheAccess(runtime.id, runtime.generation);
    await report(
      { ...runtime, generation: "g-fedcba9876543210", state: "READY" },
      { ...other, state: "READY" },
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();

    cacheAccess(runtime.id, runtime.generation);
    await report({ ...runtime, state: "FAILED" }, { ...other, state: "READY" });
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();
    panel.dispose();
  });

  it("does not let a slow initial read overwrite a newer poll", async () => {
    const bootstrap =
      Promise.withResolvers<ReturnType<typeof runtimeListFixture>>();
    const cached = { ...runtime, state: "FAILED" as const, error: "cached" };
    const api = {
      signIn: vi.fn(async () => undefined),
      listRuntimes: vi.fn(() => bootstrap.promise),
      listSshHosts: vi.fn(async () => []),
    };
    const panel = panelFor(api);
    const signedIn = panel.signIn();

    api.listRuntimes.mockResolvedValue(runtimeListFixture([runtime]));
    await pollPanel(panel);
    expect(panel.state.runtimes[0]?.state).toBe("QUEUED");

    bootstrap.resolve(runtimeListFixture([cached]));
    await signedIn;
    expect(panel.state.runtimes[0]?.state).toBe("QUEUED");
    expect(panel.state.runtimes[0]?.error).toBeUndefined();
    panel.dispose();
  });
});
