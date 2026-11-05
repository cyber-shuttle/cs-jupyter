// Runs CILogon's authorization-code flow with PKCE, finished by the CyberShuttle
// API because only it holds the client secret. Sign-in navigates the top window
// away; the callback exchange happens on the next load, from the `code` and
// `state` the redirect carries. The credential is held in per-tab
// sessionStorage so it survives that navigation.
import {
  isPlainObject,
  planeApi,
  unwrap,
  type IPlaneAuth,
  type PlaneApi,
  type Schemas,
  validPlaneApiUrl,
  base64UrlEncode,
} from "./Common";

const REQUEST_TIMEOUT_MS = 15 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;
const SIGN_IN_KEY = "cybershuttle.oauth.v1";
const PKCE_KEY = "cybershuttle.oauth.pkce.v1";

export class AuthInteractionRequiredError extends Error {
  constructor(message = "Sign in to CyberShuttle to continue.") {
    super(message);
    this.name = "AuthInteractionRequiredError";
  }
}

export interface IAuthClientDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  navigate?: (url: string) => void;
}

interface IStoredCredentials {
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface IPendingSignIn {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo?: string;
}

function readStored<T>(key: string): T | undefined {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "") as T;
  } catch {
    return undefined;
  }
}

function identityFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    if (!isPlainObject(claims)) return undefined;
    return ["email", "name", "sub"]
      .map((claim) => claims[claim])
      .find((value) => typeof value === "string" && value);
  } catch {
    return undefined;
  }
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export class AuthClient implements IPlaneAuth {
  private readonly _base: string;
  private readonly _api: PlaneApi;
  private readonly _now: () => number;
  private readonly _navigate: (url: string) => void;
  private _credentials: IStoredCredentials | undefined;
  private _callback: Promise<void> | undefined;
  private _refreshing: Promise<void> | undefined;
  private _generation = 0;

  constructor(planeApiUrl: string, dependencies: IAuthClientDependencies = {}) {
    this._base = validPlaneApiUrl(planeApiUrl);
    this._api = planeApi(
      this._base,
      dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    );
    this._now = dependencies.now ?? Date.now;
    this._navigate =
      dependencies.navigate ?? ((url) => window.location.assign(url));
    const stored = readStored<IStoredCredentials>(SIGN_IN_KEY);
    if (stored && stored.expiresAt > this._now()) {
      this._credentials = stored;
    } else {
      sessionStorage.removeItem(SIGN_IN_KEY);
    }
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code");
    const state = query.get("state");
    if (code && state) {
      this._callback = this._completeCallback(code, state);
    }
  }

  get identity(): string | undefined {
    return this._credentials && identityFromIdToken(this._credentials.idToken);
  }

  async acquireToken(): Promise<string> {
    if (this._callback) {
      const callback = this._callback;
      this._callback = undefined;
      await callback;
    }
    let credentials = this._credentials;
    if (!credentials) {
      throw new AuthInteractionRequiredError();
    }
    if (this._now() >= credentials.expiresAt) {
      this.invalidateToken();
      throw new AuthInteractionRequiredError();
    }
    if (
      this._now() >= credentials.expiresAt - REFRESH_MARGIN_MS &&
      credentials.refreshToken
    ) {
      const refreshing =
        this._refreshing ??
        (this._refreshing = this._refresh(credentials, this._generation));
      try {
        await refreshing;
      } catch {}
      if (this._refreshing === refreshing) {
        this._refreshing = undefined;
      }
      credentials = this._credentials;
    }
    if (!credentials || this._now() >= credentials.expiresAt) {
      this.invalidateToken();
      throw new AuthInteractionRequiredError();
    }
    return credentials.idToken;
  }

  invalidateToken(): void {
    this._generation++;
    this._credentials = undefined;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  async signIn(): Promise<void> {
    const config = await this._call((init) =>
      this._api.GET("/api/v1/auth/config", init),
    );
    const { verifier, challenge } = await pkcePair();
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const redirect = new URL(window.location.href);
    redirect.search = "";
    redirect.hash = "";
    const pending: IPendingSignIn = {
      state,
      verifier,
      redirectUri: redirect.toString(),
      returnTo: window.location.href,
    };
    sessionStorage.setItem(PKCE_KEY, JSON.stringify(pending));
    const authorize = new URL(config.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: config.client_id,
      scope: config.scope,
      redirect_uri: pending.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    this._navigate(authorize.toString());
  }

  private async _completeCallback(code: string, state: string): Promise<void> {
    const pending = readStored<IPendingSignIn>(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    if (!pending) {
      throw new Error("No sign-in was in progress for this callback.");
    }
    if (pending.state !== state) {
      throw new Error("Sign-in state did not match; try signing in again.");
    }
    this._store(
      await this._redeem({
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
      }),
    );
    window.history.replaceState(
      window.history.state,
      "",
      pending.returnTo ?? pending.redirectUri,
    );
  }

  private async _refresh(
    credentials: IStoredCredentials,
    generation: number,
  ): Promise<void> {
    const refreshToken = credentials.refreshToken!;
    const tokens = await this._redeem({ refresh_token: refreshToken });
    if (this._generation === generation && this._credentials === credentials) {
      this._store({
        ...tokens,
        refresh_token: tokens.refresh_token ?? refreshToken,
      });
    }
  }

  private _redeem(grant: Record<string, string>): Promise<Schemas["Tokens"]> {
    return this._call((init) =>
      this._api.POST("/api/v1/auth/token", { ...init, body: grant }),
    );
  }

  private _store(tokens: Schemas["Tokens"]): void {
    this._generation++;
    this._credentials = {
      idToken: tokens.id_token,
      expiresAt: this._now() + tokens.expires_in * 1000,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
    sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(this._credentials));
  }

  private async _call<T>(
    send: (
      init: Omit<RequestInit, "body">,
    ) => Promise<{ data?: T; error?: unknown; response: Response }>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return unwrap(
      send({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      }),
    ).catch((error: unknown) => {
      throw signal.aborted ? new Error("Sign-in request timed out.") : error;
    });
  }
}
