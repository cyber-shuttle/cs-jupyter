// Cross-origin auth headers on PlaneClient requests; a refused bearer ends the
// sign-in.
import { fakeAuth } from "./fakes";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { PlaneClient, safePlaneFetch } from "../src/PlaneClient";
import { jsonResponse } from "../src/Common";

const auth = fakeAuth();

afterEach(() => {
  sessionStorage.clear();
});

describe("OAuth cross-origin CyberShuttle API client", () => {
  it("sends only a bearer ID token and this tab's connection to the configured CyberShuttle API origin", async () => {
    const browserFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse([]),
    );
    const client = new PlaneClient(
      "https://plane.example.edu/api/v1",
      auth,
      browserFetch,
    );
    await expect(client.listSessions()).resolves.toEqual([]);
    const [input, init] = browserFetch.mock.calls[0];
    assert.isDefined(init);
    expect((input as Request).url).toBe(
      "https://plane.example.edu/api/v1/sessions/me",
    );
    const headers = new Headers(init.headers);
    expect([...headers]).toEqual([
      ["authorization", "Bearer delegated-token"],
      ["x-connection-id", sessionStorage.getItem("cybershuttle.connection.v1")],
    ]);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  it("invalidates delegated access after HTTP 401", async () => {
    auth.invalidateToken.mockClear();
    const guarded = safePlaneFetch(
      "https://plane.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 401 }),
      ),
    );
    await guarded("https://plane.example.edu/api/v1/sessions");
    expect(auth.invalidateToken).toHaveBeenCalledOnce();
  });

  it("keeps delegated access after HTTP 403", async () => {
    auth.invalidateToken.mockClear();
    const guarded = safePlaneFetch(
      "https://plane.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 403 }),
      ),
    );
    await guarded("https://plane.example.edu/api/v1/sessions");
    expect(auth.invalidateToken).not.toHaveBeenCalled();
  });

  it("rejects unrelated origins", async () => {
    const guarded = safePlaneFetch(
      "https://plane.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 200 }),
      ),
    );
    await expect(guarded("https://hostile.example/api/v1")).rejects.toThrow(
      "outside the configured origin",
    );
  });
});
