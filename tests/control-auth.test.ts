import { fakeAuth } from "./fakes";
import { describe, expect, it, vi } from "vitest";
import { ControlClient, safeControlFetch } from "../src/ControlClient";

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

  it("rejects unrelated origins and redirect responses", async () => {
    const guarded = safeControlFetch(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn(async () => new Response(null, { status: 302 })) as any,
    );
    await expect(guarded("https://hostile.example/api/v1")).rejects.toThrow(
      "outside the configured control origin",
    );
    await expect(
      guarded("https://control.example.edu/api/v1/runtimes"),
    ).rejects.toThrow("redirects");
  });
});
