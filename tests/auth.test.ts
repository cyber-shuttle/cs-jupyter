// Exercises AuthClient's CILogon authorization-code flow with PKCE: the
// outbound redirect it builds, the inbound callback it completes on load, and
// the token refresh acquireToken performs near expiry. Credentials persist
// only in per-tab session storage, since local storage would outlive the tab.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthClient,
  AuthInteractionRequiredError,
  type IAuthClientDependencies,
} from "../src/AuthClient";

const controlApiUrl = "https://control.example.edu/api/v1";

const config = {
  issuer: "https://cilogon.org",
  authorizationEndpoint: "https://cilogon.org/authorize",
  clientId: "cilogon:/client_id/abc",
  scope: "openid email profile offline_access",
};

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

interface MockReply {
  status?: number;
  body: unknown;
  contentType?: string;
  redirected?: boolean;
}

function fetchSequence(replies: Array<MockReply | Error>): typeof fetch {
  return vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected sign-in request");
    if (next instanceof Error) throw next;
    const response = new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": next.contentType ?? "application/json" },
    });
    if (next.redirected) {
      Object.defineProperty(response, "redirected", { value: true });
    }
    return response;
  }) as unknown as typeof fetch;
}

function setUrl(path: string): void {
  window.history.replaceState({}, "", path);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setUrl("/lite/lab/");
});

describe("AuthClient interactive sign-in", () => {
  it("builds the authorize URL from cs-control's config and stores state and verifier", async () => {
    const navigate = vi.fn();
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([{ body: config }]),
      navigate,
    });

    await auth.interactiveLogin();

    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("scope")).toBe(config.scope);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/lite/lab/",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const challenge = url.searchParams.get("code_challenge")!;
    expect(state).toBeTruthy();
    expect(challenge).toBeTruthy();

    const pending = JSON.parse(
      sessionStorage.getItem("cybershuttle.oauth.pkce.v1")!,
    );
    expect(pending.state).toBe(state);
    expect(pending.redirectUri).toBe("http://localhost:3000/lite/lab/");
    const expectedChallenge = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(pending.verifier))
      .then((digest) =>
        btoa(String.fromCharCode(...new Uint8Array(digest)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      );
    expect(challenge).toBe(expectedChallenge);
  });
});

describe("AuthClient callback exchange", () => {
  function seedPending(state: string, verifier = "verifier-value"): void {
    sessionStorage.setItem(
      "cybershuttle.oauth.pkce.v1",
      JSON.stringify({
        state,
        verifier,
        redirectUri: "http://localhost:3000/lite/lab/",
      }),
    );
  }

  it("returns to the page the sign-in left, query included", async () => {
    sessionStorage.setItem(
      "cybershuttle.oauth.pkce.v1",
      JSON.stringify({
        state: "s",
        verifier: "v",
        redirectUri: "http://localhost:3000/lite/lab/",
        returnTo:
          "http://localhost:3000/lite/lab/?session=s-abc&workspace=s-abc",
      }),
    );
    setUrl("/lite/lab/?code=auth-code&state=s");
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([
        { body: { idToken: jwt({ sub: "x" }), expiresInSeconds: 900 } },
      ]),
    });
    await auth.acquireToken();
    expect(window.location.search).toBe("?session=s-abc&workspace=s-abc");
  });

  it("exchanges the code for a credential and strips the query", async () => {
    seedPending("matching-state");
    setUrl("/lite/lab/?code=auth-code&state=matching-state");
    const idToken = jwt({ email: "user@example.edu" });
    const dependencies: IAuthClientDependencies = {
      fetch: fetchSequence([
        { body: { idToken, refreshToken: "refresh-1", expiresInSeconds: 900 } },
      ]),
    };
    const auth = new AuthClient(controlApiUrl, dependencies);

    await expect(auth.acquireToken()).resolves.toEqual({ idToken });
    expect(auth.account).toBe("user@example.edu");
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("cybershuttle.oauth.pkce.v1")).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem("cybershuttle.oauth.v1")!),
    ).toMatchObject({ idToken, refreshToken: "refresh-1" });

    const [url, init] = vi.mocked(dependencies.fetch!).mock.calls[0];
    expect(String(url)).toBe(`${controlApiUrl}/oauth/exchange`);
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "auth-code",
      codeVerifier: "verifier-value",
      redirectUri: "http://localhost:3000/lite/lab/",
    });
  });

  it("rejects a state mismatch and leaves the caller unauthenticated", async () => {
    seedPending("expected-state");
    setUrl("/lite/lab/?code=auth-code&state=wrong-state");
    const auth = new AuthClient(controlApiUrl, { fetch: fetchSequence([]) });

    await expect(auth.acquireToken()).rejects.toThrow("state did not match");
  });

  it("rejects a callback with no sign-in in progress", async () => {
    setUrl("/lite/lab/?code=auth-code&state=some-state");
    const auth = new AuthClient(controlApiUrl, { fetch: fetchSequence([]) });

    await expect(auth.acquireToken()).rejects.toThrow(
      "No sign-in was in progress",
    );
  });
});

describe("AuthClient token refresh", () => {
  it("refreshes a credential within a minute of expiry", async () => {
    let now = 0;
    const idToken = jwt({ sub: "owner" });
    const refreshed = jwt({ sub: "owner" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({
        idToken,
        refreshToken: "refresh-old",
        expiresAt: 30_000,
      }),
    );
    const dependencies: IAuthClientDependencies = {
      fetch: fetchSequence([
        {
          body: {
            idToken: refreshed,
            refreshToken: "refresh-new",
            expiresInSeconds: 900,
          },
        },
      ]),
      now: () => now,
    };
    const auth = new AuthClient(controlApiUrl, dependencies);

    await expect(auth.acquireToken()).resolves.toEqual({ idToken: refreshed });
    const [url, init] = vi.mocked(dependencies.fetch!).mock.calls[0];
    expect(String(url)).toBe(`${controlApiUrl}/oauth/refresh`);
    expect(JSON.parse(String(init?.body))).toEqual({
      refreshToken: "refresh-old",
    });
    expect(
      JSON.parse(sessionStorage.getItem("cybershuttle.oauth.v1")!),
    ).toMatchObject({ idToken: refreshed, refreshToken: "refresh-new" });
  });

  it("keeps serving the still-valid token when a refresh attempt fails", async () => {
    const idToken = jwt({ sub: "owner" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({
        idToken,
        refreshToken: "refresh-old",
        expiresAt: 30_000,
      }),
    );
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([new TypeError("network unavailable")]),
      now: () => 0,
    });

    await expect(auth.acquireToken()).resolves.toEqual({ idToken });
  });

  it("requires interaction once an unrefreshable credential fully expires", async () => {
    const idToken = jwt({ sub: "owner" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken, expiresAt: 1_000 }),
    );
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([]),
      now: () => 2_000,
    });

    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
    expect(sessionStorage.getItem("cybershuttle.oauth.v1")).toBeNull();
  });
});

describe("AuthClient account claim", () => {
  it.each([
    [
      { email: "person@example.edu", name: "Person", sub: "abc" },
      "person@example.edu",
    ],
    [{ name: "Person", sub: "abc" }, "Person"],
    [{ sub: "abc" }, "abc"],
    [{}, undefined],
  ] as const)("prefers email, then name, then sub: %j", (claims, expected) => {
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken: jwt(claims), expiresAt: 3_600_000 }),
    );
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([]),
      now: () => 0,
    });
    expect(auth.account).toBe(expected);
  });
});

describe("AuthClient credential persistence", () => {
  it.each([
    { name: "no id token", record: { expiresAt: 3_600_000 } },
    {
      name: "a non-string id token",
      record: { idToken: 12345, expiresAt: 3_600_000 },
    },
    { name: "an expired record", record: { idToken: "x", expiresAt: 0 } },
  ])("refuses a stored record with $name", async ({ record }) => {
    sessionStorage.setItem("cybershuttle.oauth.v1", JSON.stringify(record));
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([]),
      now: () => 1_000,
    });
    expect(auth.account).toBeUndefined();
    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
  });

  it("restores an unexpired credential into a fresh client", async () => {
    const idToken = jwt({ email: "person@example.edu" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken, expiresAt: 3_600_000 }),
    );
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([]),
      now: () => 1_000,
    });
    await expect(auth.acquireToken()).resolves.toEqual({ idToken });
    expect(auth.account).toBe("person@example.edu");
  });

  it("invalidates the credential and clears session storage", async () => {
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken: jwt({ sub: "x" }), expiresAt: 3_600_000 }),
    );
    const auth = new AuthClient(controlApiUrl, {
      fetch: fetchSequence([]),
      now: () => 0,
    });
    auth.invalidateToken();
    expect(sessionStorage.getItem("cybershuttle.oauth.v1")).toBeNull();
    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
  });
});

describe("AuthClient response validation", () => {
  it("rejects a redirected, non-JSON, or malformed exchange response", async () => {
    for (const reply of [
      { body: { idToken: "x", expiresInSeconds: 900 }, redirected: true },
      {
        body: { idToken: "x", expiresInSeconds: 900 },
        contentType: "text/plain",
      },
      { body: { expiresInSeconds: 900 } },
      { body: { idToken: "x", expiresInSeconds: 0 } },
    ]) {
      sessionStorage.setItem(
        "cybershuttle.oauth.pkce.v1",
        JSON.stringify({
          state: "s",
          verifier: "v",
          redirectUri: "http://localhost:3000/lite/lab/",
        }),
      );
      setUrl("/lite/lab/?code=c&state=s");
      const auth = new AuthClient(controlApiUrl, {
        fetch: fetchSequence([reply]),
      });
      await expect(auth.acquireToken()).rejects.toThrow(/invalid/i);
    }
  });

  it("rejects unsafe control URLs", () => {
    expect(
      () => new AuthClient("https://secret@control.example/api/v1"),
    ).toThrow("invalid");
    expect(() => new AuthClient("http://control.example/api/v1")).toThrow(
      "invalid",
    );
  });
});
