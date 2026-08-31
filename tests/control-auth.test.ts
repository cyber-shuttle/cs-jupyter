import { fakeAuth } from "./fakes";
import { describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  safeControlFetch,
  UNCHANGED,
} from "../src/ControlClient";

const auth = { ...fakeAuth(), invalidateToken: vi.fn() };

describe("OAuth cross-origin control client", () => {
  it("sends bearer with omitted credentials to only the configured control origin", async () => {
    const browserFetch = vi.fn(
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
    expect(String(input)).toBe("https://control.example.edu/api/v1/ssh");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer delegated-token",
    );
    expect(new Headers(init.headers).get("X-CyberShuttle-Identity")).toBe(
      "identity-token",
    );
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
        vi.fn(async () => new Response(null, { status })) as any,
      );
      await expect(
        guarded("https://control.example.edu/api/v1/runtimes"),
      ).resolves.toMatchObject({ status });
      expect(auth.invalidateToken).toHaveBeenCalledOnce();
    },
  );

  it("rejects unrelated origins", async () => {
    const guarded = safeControlFetch(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn(async () => new Response(null, { status: 200 })) as any,
    );
    await expect(guarded("https://hostile.example/api/v1")).rejects.toThrow(
      "outside the configured control origin",
    );
  });
});

describe("conditional runtime polling", () => {
  const list = { runtimes: [], logs: [] };
  const etag = '"abc123"';

  function client(browserFetch: typeof globalThis.fetch) {
    return new ControlClient(
      "https://control.example.edu/api/v1",
      auth,
      browserFetch,
    );
  }

  it("offers the previous ETag and skips the body cs-control says is unchanged", async () => {
    const browserFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(list), {
          headers: { "content-type": "application/json", ETag: etag },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const api = client(browserFetch as unknown as typeof globalThis.fetch);

    await expect(api.listRuntimes()).resolves.toEqual(list);
    // Nothing to revalidate against on the first read.
    expect(
      new Headers(browserFetch.mock.calls[0][1].headers).has("If-None-Match"),
    ).toBe(false);

    await expect(api.listRuntimes()).resolves.toBe(UNCHANGED);
    expect(
      new Headers(browserFetch.mock.calls[1][1].headers).get("If-None-Match"),
    ).toBe(etag);
  });

  it("keeps polling conditionally after an unchanged answer", async () => {
    const browserFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(list), {
          headers: { "content-type": "application/json", ETag: etag },
        }),
      )
      .mockResolvedValue(new Response(null, { status: 304 }));
    const api = client(browserFetch as unknown as typeof globalThis.fetch);

    await api.listRuntimes();
    await api.listRuntimes();
    await expect(api.listRuntimes()).resolves.toBe(UNCHANGED);
    // A 304 carries no ETag of its own; the stored one must survive it.
    expect(
      new Headers(browserFetch.mock.calls[2][1].headers).get("If-None-Match"),
    ).toBe(etag);
  });
});
