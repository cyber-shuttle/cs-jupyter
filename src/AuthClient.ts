// Runs CILogon's authorization-code flow with PKCE, finished by cs-control
// because only it holds the client secret. Sign-in navigates the top window
// away; the callback exchange happens on the next load, from the `code` and
// `state` the redirect carries. The credential is held in per-tab
// sessionStorage so it survives that navigation. Every cs-control response is
// validated strictly against its expected shape.
import {
  isPlainObject,
  vBoundedInt,
  vNumber,
  vObject,
  vOptional,
  vString,
  type Validator,
  validControlApiUrl,
  type OAuthCredentials,
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

interface IOAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  clientId: string;
  scope: string;
}

interface IOAuthTokens {
  idToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

interface IPendingSignIn {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo?: string;
}

const oauthConfigShape = vObject<IOAuthConfig>({
  issuer: vString(),
  authorizationEndpoint: vString(),
  clientId: vString(),
  scope: vString(),
});

const oauthTokensShape = vObject<IOAuthTokens>({
  idToken: vString(),
  refreshToken: vOptional(vString()),
  expiresInSeconds: vBoundedInt(1, 86400),
});

const storedCredentialsShape = vObject<IStoredCredentials>({
  idToken: vString(),
  refreshToken: vOptional(vString()),
  expiresAt: vNumber,
});

const pendingSignInShape = vObject<IPendingSignIn>({
  state: vString(),
  verifier: vString(),
  redirectUri: vString(),
  returnTo: vOptional(vString()),
});

function readStored<T>(key: string, shape: Validator<T>): T | undefined {
  const raw = sessionStorage.getItem(key);
  try {
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    return shape(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function accountFromIdToken(idToken: string): string | undefined {
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

export class AuthClient {
  private readonly _base: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _now: () => number;
  private readonly _navigate: (url: string) => void;
  private _credentials: IStoredCredentials | undefined;
  private _callback: Promise<void> | undefined;
  private _refreshing: Promise<void> | undefined;
  private _generation = 0;

  constructor(
    controlApiUrl: string,
    dependencies: IAuthClientDependencies = {},
  ) {
    this._base = validControlApiUrl(controlApiUrl);
    this._fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this._now = dependencies.now ?? Date.now;
    this._navigate =
      dependencies.navigate ?? ((url) => window.location.assign(url));
    const stored = readStored(SIGN_IN_KEY, storedCredentialsShape);
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

  get account(): string | undefined {
    return this._credentials && accountFromIdToken(this._credentials.idToken);
  }

  async acquireToken(): Promise<OAuthCredentials> {
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
    return { idToken: credentials.idToken };
  }

  invalidateToken(): void {
    this._generation++;
    this._credentials = undefined;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  async interactiveLogin(): Promise<void> {
    const config = await this._call(
      `${this._base}/oauth/config`,
      oauthConfigShape,
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
    const authorize = new URL(config.authorizationEndpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      scope: config.scope,
      redirect_uri: pending.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    this._navigate(authorize.toString());
  }

  private async _completeCallback(code: string, state: string): Promise<void> {
    const pending = readStored(PKCE_KEY, pendingSignInShape);
    sessionStorage.removeItem(PKCE_KEY);
    if (!pending) {
      throw new Error("No sign-in was in progress for this callback.");
    }
    if (pending.state !== state) {
      throw new Error("Sign-in state did not match; try signing in again.");
    }
    const tokens = await this._call(
      `${this._base}/oauth/exchange`,
      oauthTokensShape,
      {
        code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
      },
    );
    this._store(tokens);
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
    const tokens = await this._call(
      `${this._base}/oauth/refresh`,
      oauthTokensShape,
      { refreshToken },
    );
    if (this._generation === generation && this._credentials === credentials) {
      this._store({
        ...tokens,
        refreshToken: tokens.refreshToken ?? refreshToken,
      });
    }
  }

  private _store(tokens: IOAuthTokens): void {
    this._generation++;
    this._credentials = {
      idToken: tokens.idToken,
      expiresAt: this._now() + tokens.expiresInSeconds * 1000,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(this._credentials));
  }

  private async _call<T>(
    url: string,
    shape: Validator<T>,
    body?: Record<string, string>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this._fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body && JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    }).catch((error: unknown) => {
      throw signal.aborted
        ? new Error("cs-control sign-in request timed out.")
        : error;
    });
    const value: unknown = await response.json().catch(() => {
      throw new Error("cs-control returned invalid JSON.");
    });
    if (!response.ok) {
      const error =
        isPlainObject(value) && isPlainObject(value.error) ? value.error : {};
      throw new Error(
        typeof error.message === "string"
          ? error.message
          : `cs-control sign-in failed (${response.status}${typeof error.code === "string" ? `: ${error.code}` : ""}).`,
      );
    }
    if (!shape(value)) {
      throw new Error("cs-control returned an invalid sign-in response.");
    }
    return value;
  }
}
