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
import { jsonResponse } from "../src/Common";

const planeApiUrl = "https://plane.example.edu/api/v1";

const config = {
  issuer: "https://cilogon.org",
  authorization_endpoint: "https://cilogon.org/authorize",
  client_id: "cilogon:/client_id/abc",
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
}

function fetchSequence(replies: Array<MockReply | Error>): typeof fetch {
  return vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected sign-in request");
    if (next instanceof Error) throw next;
    return jsonResponse(next.body, { status: next.status });
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
  it("builds the authorize URL from the CyberShuttle API's config and stores state and verifier", async () => {
    const navigate = vi.fn();
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([{ body: config }]),
      navigate,
    });

    await auth.signIn();

    expect(navigate).toHaveBeenCalledTimes(1);
    const url = new URL(navigate.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(config.authorization_endpoint);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.client_id);
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
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([
        { body: { id_token: jwt({ sub: "x" }), expires_in: 900 } },
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
        {
          body: {
            id_token: idToken,
            refresh_token: "refresh-1",
            expires_in: 900,
          },
        },
      ]),
    };
    const auth = new AuthClient(planeApiUrl, dependencies);

    await expect(auth.acquireToken()).resolves.toBe(idToken);
    expect(auth.identity).toBe("user@example.edu");
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem("cybershuttle.oauth.pkce.v1")).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem("cybershuttle.oauth.v1")!),
    ).toMatchObject({ idToken, refreshToken: "refresh-1" });

    const request = vi.mocked(dependencies.fetch!).mock.calls[0][0] as Request;
    expect(request.url).toBe(`${planeApiUrl}/auth/token`);
    expect(await request.json()).toEqual({
      code: "auth-code",
      code_verifier: "verifier-value",
      redirect_uri: "http://localhost:3000/lite/lab/",
    });
  });

  it("rejects a state mismatch and leaves the caller unauthenticated", async () => {
    seedPending("expected-state");
    setUrl("/lite/lab/?code=auth-code&state=wrong-state");
    const auth = new AuthClient(planeApiUrl, { fetch: fetchSequence([]) });

    await expect(auth.acquireToken()).rejects.toThrow("state did not match");
  });

  it("rejects a callback with no sign-in in progress", async () => {
    setUrl("/lite/lab/?code=auth-code&state=some-state");
    const auth = new AuthClient(planeApiUrl, { fetch: fetchSequence([]) });

    await expect(auth.acquireToken()).rejects.toThrow(
      "No sign-in was in progress",
    );
  });
});

describe("AuthClient token refresh", () => {
  it("shares one refresh across concurrent token acquisitions", async () => {
    const idToken = jwt({ sub: "owner" });
    const refreshed = jwt({ sub: "owner", generation: 2 });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({
        idToken,
        refreshToken: "refresh-old",
        expiresAt: 30_000,
      }),
    );
    const reply = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => reply.promise);
    const auth = new AuthClient(planeApiUrl, { fetch, now: () => 0 });

    const first = auth.acquireToken();
    const second = auth.acquireToken();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    reply.resolve(
      new Response(JSON.stringify({ id_token: refreshed, expires_in: 900 }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      refreshed,
      refreshed,
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      JSON.parse(sessionStorage.getItem("cybershuttle.oauth.v1")!).refreshToken,
    ).toBe("refresh-old");
  });

  it("does not restore credentials invalidated during refresh", async () => {
    const idToken = jwt({ sub: "owner" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({
        idToken,
        refreshToken: "refresh-old",
        expiresAt: 30_000,
      }),
    );
    const reply = Promise.withResolvers<Response>();
    const auth = new AuthClient(planeApiUrl, {
      fetch: vi.fn(() => reply.promise),
      now: () => 0,
    });

    const acquiring = auth.acquireToken();
    auth.invalidateToken();
    reply.resolve(
      new Response(
        JSON.stringify({
          id_token: jwt({ sub: "stale" }),
          expires_in: 900,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(acquiring).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
    expect(sessionStorage.getItem("cybershuttle.oauth.v1")).toBeNull();
  });

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
            id_token: refreshed,
            refresh_token: "refresh-new",
            expires_in: 900,
          },
        },
      ]),
      now: () => now,
    };
    const auth = new AuthClient(planeApiUrl, dependencies);

    await expect(auth.acquireToken()).resolves.toBe(refreshed);
    const request = vi.mocked(dependencies.fetch!).mock.calls[0][0] as Request;
    expect(request.url).toBe(`${planeApiUrl}/auth/token`);
    expect(await request.json()).toEqual({
      refresh_token: "refresh-old",
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
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([new TypeError("network unavailable")]),
      now: () => 0,
    });

    await expect(auth.acquireToken()).resolves.toBe(idToken);
  });

  it("requires interaction once an unrefreshable credential fully expires", async () => {
    const idToken = jwt({ sub: "owner" });
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken, expiresAt: 1_000 }),
    );
    const auth = new AuthClient(planeApiUrl, {
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
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([]),
      now: () => 0,
    });
    expect(auth.identity).toBe(expected);
  });
});

describe("AuthClient credential persistence", () => {
  it("refuses an expired stored record", async () => {
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken: "x", expiresAt: 0 }),
    );
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([]),
      now: () => 1_000,
    });
    expect(auth.identity).toBeUndefined();
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
    const auth = new AuthClient(planeApiUrl, {
      fetch: fetchSequence([]),
      now: () => 1_000,
    });
    await expect(auth.acquireToken()).resolves.toBe(idToken);
    expect(auth.identity).toBe("person@example.edu");
  });
});
