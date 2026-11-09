// Signs in with a CyberShuttle API token the user pastes, kept only once the
// API accepts it. The token is held in per-tab sessionStorage until sign-out or
// the first 401.
import { InputDialog } from "@jupyterlab/apputils";
import {
  planeApi,
  unwrap,
  type IPlaneAuth,
  type PlaneApi,
  validPlaneApiUrl,
} from "./Common";

const REQUEST_TIMEOUT_MS = 15 * 1000;
const SIGN_IN_KEY = "cybershuttle.token.v1";

export class AuthInteractionRequiredError extends Error {
  constructor(message = "Sign in to CyberShuttle to continue.") {
    super(message);
    this.name = "AuthInteractionRequiredError";
  }
}

export interface IAuthClientDependencies {
  fetch?: typeof globalThis.fetch;
  prompt?: () => Promise<string | null>;
}

async function promptToken(): Promise<string | null> {
  const { button, value } = await InputDialog.getPassword({
    title: "Sign in to CyberShuttle",
    label: "CyberShuttle API token",
    okLabel: "Sign in",
  });
  return button.accept ? value : null;
}

export class AuthClient implements IPlaneAuth {
  private readonly _api: PlaneApi;
  private readonly _prompt: () => Promise<string | null>;
  private _token = sessionStorage.getItem(SIGN_IN_KEY) ?? undefined;

  constructor(planeApiUrl: string, dependencies: IAuthClientDependencies = {}) {
    this._api = planeApi(
      validPlaneApiUrl(planeApiUrl),
      dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    );
    this._prompt = dependencies.prompt ?? promptToken;
  }

  async acquireToken(): Promise<string> {
    if (!this._token) {
      throw new AuthInteractionRequiredError();
    }
    return this._token;
  }

  invalidateToken(): void {
    this._token = undefined;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  async signIn(): Promise<void> {
    const token = (await this._prompt())?.trim();
    if (!token) return;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    await unwrap(
      this._api.GET("/api/v1/processes/me", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      }),
    ).catch((error: unknown) => {
      throw signal.aborted ? new Error("Sign-in request timed out.") : error;
    });
    this._token = token;
    sessionStorage.setItem(SIGN_IN_KEY, token);
  }
}
