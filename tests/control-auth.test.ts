// Cross-origin auth headers and conditional ETag-based polling for
// ControlClient's session list. A 304 response carries no ETag of its own. The
// client must retain the previous ETag across an unchanged answer to send it
// again. Every request carries only a bearer ID token.
import { etagResponse, fakeAuth } from "./fakes";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  safeControlFetch,
  UNCHANGED,
} from "../src/ControlClient";
import { jsonResponse } from "../src/Common";

const auth = { ...fakeAuth(), invalidateToken: vi.fn() };

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("OAuth cross-origin control client", () => {
  it("sends only a bearer ID token to the configured control origin", async () => {
    const browserFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ hosts: [] }),
    );
    const client = new ControlClient(
      "https://control.example.edu/api/v1",
      auth,
      browserFetch,
    );
    await expect(client.listSshHosts()).resolves.toEqual([]);
    const [input, init] = browserFetch.mock.calls[0];
    assert.isDefined(init);
    expect(String(input)).toBe("https://control.example.edu/api/v1/hosts");
    const headers = new Headers(init.headers);
    expect([...headers]).toEqual([["authorization", "Bearer delegated-token"]]);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  it("invalidates delegated access after HTTP 401", async () => {
    auth.invalidateToken.mockClear();
    const guarded = safeControlFetch(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 401 }),
      ),
    );
    await guarded("https://control.example.edu/api/v1/sessions");
    expect(auth.invalidateToken).toHaveBeenCalledOnce();
  });

  it("keeps delegated access after HTTP 403", async () => {
    auth.invalidateToken.mockClear();
    const guarded = safeControlFetch(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 403 }),
      ),
    );
    await guarded("https://control.example.edu/api/v1/sessions");
    expect(auth.invalidateToken).not.toHaveBeenCalled();
  });

  it("uses a custom control base for its default AuthClient", async () => {
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({
        idToken: "old-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 30_000,
      }),
    );
    const browserFetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/oauth/refresh")
        ? jsonResponse({ idToken: "new-token", expiresInSeconds: 900 })
        : jsonResponse({ hosts: [] }),
    );
    vi.stubGlobal("fetch", browserFetch);

    await new ControlClient(
      "https://custom-control.example.edu/custom/api/v1",
    ).listSshHosts();

    expect(browserFetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://custom-control.example.edu/custom/api/v1/oauth/refresh",
      "https://custom-control.example.edu/custom/api/v1/hosts",
    ]);
  });

  it("rejects unrelated origins", async () => {
    const guarded = safeControlFetch(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status: 200 }),
      ),
    );
    await expect(guarded("https://hostile.example/api/v1")).rejects.toThrow(
      "outside the configured control origin",
    );
  });
});

describe("conditional session polling", () => {
  const list = { sessions: [], logs: [] };
  const etag = '"abc123"';

  function client(browserFetch: typeof globalThis.fetch) {
    return new ControlClient(
      "https://control.example.edu/api/v1",
      auth,
      browserFetch,
    );
  }

  it("offers the previous ETag and keeps polling conditionally after an unchanged answer", async () => {
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(etagResponse(list, etag))
      .mockResolvedValue(new Response(null, { status: 304 }));
    const api = client(browserFetch);

    await expect(api.listSessions()).resolves.toEqual(list);
    const [, firstInit] = browserFetch.mock.calls[0];
    assert.isDefined(firstInit);
    expect(new Headers(firstInit.headers).has("If-None-Match")).toBe(false);

    await expect(api.listSessions()).resolves.toBe(UNCHANGED);
    await expect(api.listSessions()).resolves.toBe(UNCHANGED);
    for (const [, init] of browserFetch.mock.calls.slice(1)) {
      assert.isDefined(init);
      expect(new Headers(init.headers).get("If-None-Match")).toBe(etag);
    }
  });
});
