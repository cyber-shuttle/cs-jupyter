// Exercises AuthClient's token sign-in: a pasted token is checked against the
// CyberShuttle API before it is kept, and it persists only in per-tab session
// storage, since local storage would outlive the tab.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthClient, AuthInteractionRequiredError } from "../src/AuthClient";
import { jsonResponse } from "../src/Common";

const planeApiUrl = "https://plane.example.edu/api/v1";
const KEY = "cybershuttle.token.v1";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("AuthClient token sign-in", () => {
  it("keeps a pasted token once processes/me accepts it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse([]));
    const auth = new AuthClient(planeApiUrl, {
      fetch,
      prompt: async () => "  pasted-token \n",
    });

    await auth.signIn();

    const request = fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(`${planeApiUrl}/processes/me`);
    expect(request.headers.get("Authorization")).toBe("Bearer pasted-token");
    await expect(auth.acquireToken()).resolves.toBe("pasted-token");
    expect(sessionStorage.getItem(KEY)).toBe("pasted-token");
  });

  it("refuses a token the CyberShuttle API rejects", async () => {
    const auth = new AuthClient(planeApiUrl, {
      fetch: vi.fn(async () =>
        jsonResponse(
          { message: "Unable to validate bearer token" },
          { status: 401 },
        ),
      ),
      prompt: async () => "wrong",
    });

    await expect(auth.signIn()).rejects.toThrow(
      "Unable to validate bearer token",
    );
    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
