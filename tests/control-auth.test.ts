// Cross-origin auth headers and conditional ETag-based polling for
// ControlClient's session list. A 304 response carries no ETag of its own. The
// client must retain the previous ETag across an unchanged answer to send it
// again. Every request carries only a bearer ID token; there is no separate
// identity header.
import { fakeAuth } from "./fakes";
import { assert, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  safeControlFetch,
  UNCHANGED,
} from "../src/ControlClient";

const auth = { ...fakeAuth(), invalidateToken: vi.fn() };

describe("OAuth cross-origin control client", () => {
  it("sends only a bearer ID token to the configured control origin", async () => {
    const browserFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ hosts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ControlClient(
      "https://control.example.edu/api/v1",
      auth,
      browserFetch,
    );
    await expect(client.listSshHosts()).resolves.toEqual([]);
    const [input, init] = browserFetch.mock.calls[0];
    assert.isDefined(init);
    expect(String(input)).toBe("https://control.example.edu/api/v1/ssh");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer delegated-token");
    expect(headers.has("X-CyberShuttle-Identity")).toBe(false);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  });

  it.each([401, 403])(
    "invalidates delegated access after HTTP %i",
    async (status) => {
      auth.invalidateToken.mockClear();
      const guarded = safeControlFetch(
        "https://control.example.edu/api/v1",
        auth,
        vi.fn<typeof globalThis.fetch>(
          async () => new Response(null, { status }),
        ),
      );
      await expect(
        guarded("https://control.example.edu/api/v1/sessions"),
      ).resolves.toMatchObject({ status });
      expect(auth.invalidateToken).toHaveBeenCalledOnce();
    },
  );

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
      .mockResolvedValueOnce(
        new Response(JSON.stringify(list), {
          headers: { "content-type": "application/json", ETag: etag },
        }),
      )
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

  it("does not adopt an ETag from a session list that failed validation", async () => {
    const browserFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sessions: [{ state: "READY" }], logs: [] }),
          { headers: { "content-type": "application/json", ETag: etag } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(list), {
          headers: { "content-type": "application/json", ETag: etag },
        }),
      );
    const api = client(browserFetch);

    await expect(api.listSessions()).rejects.toThrow("invalid session");
    await expect(api.listSessions()).resolves.toEqual(list);
    const [, secondInit] = browserFetch.mock.calls[1];
    assert.isDefined(secondInit);
    expect(new Headers(secondInit.headers).has("If-None-Match")).toBe(false);
  });
});
