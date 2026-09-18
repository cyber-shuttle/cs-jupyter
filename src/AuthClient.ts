// Runs CILogon's authorization-code flow with PKCE, finished by cs-control
// because only it holds the client secret. Sign-in navigates the top window
// away; the callback exchange happens on the next load, from the `code` and
// `state` the redirect carries. The credential is held in per-tab
// sessionStorage so it survives that navigation. Every cs-control response is
// validated strictly against its expected shape.
import { PageConfig } from "@jupyterlab/coreutils";
import {
  isPlainObject,
  vBoundedInt,
  vObject,
  vOptional,
  vString,
  type Validator,
  validControlApiUrl,
  type OAuthCredentials,
  base64UrlEncode,
} from "./Common";

const MAX_RESPONSE_BODY = 64 * 1024;
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

function readStoredCredentials(now: number): IStoredCredentials | undefined {
  const raw = sessionStorage.getItem(SIGN_IN_KEY);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainObject(value) ||
      typeof value.idToken !== "string" ||
      (value.refreshToken !== undefined &&
        typeof value.refreshToken !== "string") ||
      !(typeof value.expiresAt === "number" && value.expiresAt > now)
    ) {
      throw new Error("stored credentials are unusable");
    }
    return {
      idToken: value.idToken,
      expiresAt: value.expiresAt,
      ...(typeof value.refreshToken === "string"
        ? { refreshToken: value.refreshToken }
        : {}),
    };
  } catch {
    sessionStorage.removeItem(SIGN_IN_KEY);
    return undefined;
  }
}

function decodeClaims(idToken: string): Record<string, unknown> | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    return isPlainObject(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function accountFromIdToken(idToken: string): string | undefined {
  const claims = decodeClaims(idToken);
  if (!claims) return undefined;
  for (const claim of ["email", "name", "sub"]) {
    const value = claims[claim];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function redirectUri(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readCallbackParams(): { code: string; state: string } | undefined {
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  const state = query.get("state");
  return code && state ? { code, state } : undefined;
}

function returnTo(href: string): void {
  window.history.replaceState(window.history.state, "", href);
}

export class AuthClient {
  private readonly _base: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _now: () => number;
  private readonly _navigate: (url: string) => void;
  private _credentials: IStoredCredentials | undefined;
  private _callback: Promise<void> | undefined;

  constructor(
    controlApiUrl?: string,
    dependencies: IAuthClientDependencies = {},
  ) {
    this._base = validControlApiUrl(
      controlApiUrl ?? PageConfig.getOption("cybershuttleControlApiUrl"),
    );
    this._fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this._now = dependencies.now ?? Date.now;
    this._navigate =
      dependencies.navigate ?? ((url) => window.location.assign(url));
    this._credentials = readStoredCredentials(this._now());
    const callback = readCallbackParams();
    if (callback) {
      this._callback = this._completeCallback(callback);
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
    if (!this._credentials) {
      throw new AuthInteractionRequiredError();
    }
    if (this._now() >= this._credentials.expiresAt) {
      this.invalidateToken();
      throw new AuthInteractionRequiredError();
    }
    if (
      this._now() >= this._credentials.expiresAt - REFRESH_MARGIN_MS &&
      this._credentials.refreshToken
    ) {
      try {
        await this._refresh(this._credentials.refreshToken);
      } catch {}
    }
    return { idToken: this._credentials.idToken };
  }

  invalidateToken(): void {
    this._credentials = undefined;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  async interactiveLogin(): Promise<void> {
    const config = await this._call(
      `${this._base}/oauth/config`,
      { method: "GET" },
      oauthConfigShape,
    );
    const { verifier, challenge } = await pkcePair();
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const uri = redirectUri();
    sessionStorage.setItem(
      PKCE_KEY,
      JSON.stringify({
        state,
        verifier,
        redirectUri: uri,
        returnTo: window.location.href,
      }),
    );
    const authorize = new URL(config.authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("scope", config.scope);
    authorize.searchParams.set("redirect_uri", uri);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    this._navigate(authorize.toString());
  }

  private async _completeCallback(callback: {
    code: string;
    state: string;
  }): Promise<void> {
    const raw = sessionStorage.getItem(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    if (!raw) {
      throw new Error("No sign-in was in progress for this callback.");
    }
    const pending: unknown = JSON.parse(raw);
    if (
      !isPlainObject(pending) ||
      typeof pending.state !== "string" ||
      typeof pending.verifier !== "string" ||
      typeof pending.redirectUri !== "string"
    ) {
      throw new Error("No sign-in was in progress for this callback.");
    }
    if (pending.state !== callback.state) {
      throw new Error("Sign-in state did not match; try signing in again.");
    }
    const tokens = await this._post(`${this._base}/oauth/exchange`, {
      code: callback.code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    this._store(tokens);
    returnTo(
      typeof pending.returnTo === "string"
        ? pending.returnTo
        : pending.redirectUri,
    );
  }

  private async _refresh(refreshToken: string): Promise<void> {
    const tokens = await this._post(`${this._base}/oauth/refresh`, {
      refreshToken,
    });
    this._store({
      ...tokens,
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
  }

  private _store(tokens: IOAuthTokens): void {
    this._credentials = {
      idToken: tokens.idToken,
      expiresAt: this._now() + tokens.expiresInSeconds * 1000,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(this._credentials));
  }

  private async _post(
    url: string,
    body: Record<string, string>,
  ): Promise<IOAuthTokens> {
    return this._call(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      oauthTokensShape,
    );
  }

  private async _call<T>(
    url: string,
    init: RequestInit,
    shape: Validator<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this._fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new Error("cs-control sign-in request timed out.");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    if (response.redirected || !jsonContentType(response)) {
      void response.body?.cancel();
      throw new Error("cs-control returned an invalid sign-in response.");
    }
    const body = await readBoundedBody(response);
    let value: unknown;
    try {
      value = body ? JSON.parse(body) : undefined;
    } catch {
      throw new Error("cs-control returned invalid JSON.");
    }
    if (!response.ok) {
      throw signInFailure(response.status, value);
    }
    if (!shape(value)) {
      throw new Error("cs-control returned an invalid sign-in response.");
    }
    return value;
  }
}

function signInFailure(status: number, value: unknown): Error {
  const error =
    isPlainObject(value) && isPlainObject(value.error) ? value.error : {};
  const { code, message } = error;
  return new Error(
    typeof message === "string"
      ? message
      : `cs-control sign-in failed (${status}${typeof code === "string" ? `: ${code}` : ""}).`,
  );
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BODY) {
      await reader.cancel();
      throw new Error("cs-control returned an oversized sign-in response.");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function jsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}
