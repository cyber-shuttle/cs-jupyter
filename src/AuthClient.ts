// Runs the Microsoft or GitHub device-code flow through cs-control's broker.
// The token is held in per-tab sessionStorage so it survives the session's
// own navigation. Every broker response is validated strictly against its
// expected shape.
import { PageConfig } from "@jupyterlab/coreutils";
import {
  TOKEN_43,
  exactKeys,
  isPlainObject,
  parseUrl,
  validControlApiUrl,
  type OAuthCredentials,
  type SignInProvider,
} from "./Common";
import { showDeviceCodeDialog } from "./DeviceCodeDialog";

const MAX_BROKER_BODY = 64 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 15 * 1000;
const GITHUB_USER_URL = "https://api.github.com/user";
const PROVIDER_LABEL: Record<SignInProvider, string> = {
  microsoft: "Microsoft",
  github: "GitHub",
};

export class AuthInteractionRequiredError extends Error {
  constructor(message = "Sign in to CyberShuttle to continue.") {
    super(message);
    this.name = "AuthInteractionRequiredError";
  }
}

export interface IAuthClientDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface DeviceAuthorization {
  label: string;
  handle: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface TokenResult extends OAuthCredentials {
  expiresInSeconds: number;
}

const SIGN_IN_KEY = "cybershuttle.oauth.v1";

function accountFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    if (!isPlainObject(claims)) {
      return undefined;
    }
    for (const claim of ["preferred_username", "email", "upn"]) {
      const value = claims[claim];
      if (typeof value === "string" && value) {
        return value;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readStoredCredentials(
  now: number,
):
  | { credentials: OAuthCredentials; account?: string; expiresAt: number }
  | undefined {
  const raw = sessionStorage.getItem(SIGN_IN_KEY);
  if (!raw) return undefined;
  try {
    const { scheme, accessToken, idToken, account, expiresAt } = JSON.parse(
      raw,
    ) as Record<string, unknown>;
    if (
      (scheme !== "Bearer" && scheme !== "github") ||
      typeof accessToken !== "string" ||
      (scheme === "Bearer") !== (typeof idToken === "string") ||
      (account !== undefined && typeof account !== "string") ||
      !(typeof expiresAt === "number" && expiresAt > now)
    ) {
      throw new Error("stored credentials are unusable");
    }
    return {
      credentials: {
        scheme,
        accessToken,
        ...(typeof idToken === "string" ? { idToken } : {}),
      },
      account,
      expiresAt,
    };
  } catch {
    sessionStorage.removeItem(SIGN_IN_KEY);
    return undefined;
  }
}

export class AuthClient {
  private readonly _startEndpoint: string;
  private readonly _pollEndpoint: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _now: () => number;
  private readonly _sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private _credentials: OAuthCredentials | undefined;
  private _account: string | undefined;
  private _expiresAt = 0;
  private _interaction:
    | { promise: Promise<OAuthCredentials>; controller: AbortController }
    | undefined;

  constructor(
    controlApiUrl?: string,
    dependencies: IAuthClientDependencies = {},
  ) {
    const base = validControlApiUrl(
      controlApiUrl ?? PageConfig.getOption("cybershuttleControlApiUrl"),
    );
    this._startEndpoint = `${base}/oauth/device/start`;
    this._pollEndpoint = `${base}/oauth/device/poll/`;
    this._fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this._now = dependencies.now ?? Date.now;
    this._sleep = dependencies.sleep ?? abortableSleep;
    const stored = readStoredCredentials(this._now());
    if (stored) {
      this._credentials = stored.credentials;
      this._account = stored.account;
      this._expiresAt = stored.expiresAt;
    }
  }

  get account(): string | undefined {
    return this._credentials && this._account;
  }

  async acquireToken(): Promise<OAuthCredentials> {
    if (!this._credentials || this._now() >= this._expiresAt) {
      this.invalidateToken();
      throw new AuthInteractionRequiredError();
    }
    return { ...this._credentials };
  }

  invalidateToken(): void {
    this._credentials = undefined;
    this._account = undefined;
    this._expiresAt = 0;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  interactiveLogin(
    provider: SignInProvider = "microsoft",
  ): Promise<OAuthCredentials> {
    if (!this._interaction) {
      const controller = new AbortController();
      const promise = this._interactiveLogin(
        provider,
        controller.signal,
      ).finally(() => {
        this._interaction = undefined;
      });
      this._interaction = { promise, controller };
    }
    return this._interaction.promise;
  }

  private async _interactiveLogin(
    provider: SignInProvider,
    signal: AbortSignal,
  ): Promise<OAuthCredentials> {
    const label = PROVIDER_LABEL[provider];
    try {
      const authorization = await this._requestDeviceCode(provider, signal);
      const dialog = showDeviceCodeDialog(authorization, () =>
        this._interaction?.controller.abort(),
      );
      try {
        const { expiresInSeconds, ...credentials } = await this._pollForToken(
          authorization,
          signal,
        );
        this._credentials = credentials;
        this._account =
          credentials.scheme === "github"
            ? await this._githubLogin(credentials.accessToken, signal)
            : accountFromIdToken(credentials.idToken ?? "");
        this._expiresAt = this._now() + expiresInSeconds * 1000;
        sessionStorage.setItem(
          SIGN_IN_KEY,
          JSON.stringify({
            ...this._credentials,
            account: this._account,
            expiresAt: this._expiresAt,
          }),
        );
        return { ...this._credentials };
      } finally {
        dialog.close();
      }
    } catch (error) {
      if (signal.aborted) throw new Error(`${label} sign-in was cancelled.`);
      throw error;
    }
  }

  private async _githubLogin(
    token: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const response = await this._fetch(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        credentials: "omit",
        signal,
      });
      const user: unknown = await response.json();
      return isPlainObject(user) && typeof user.login === "string"
        ? user.login
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async _requestDeviceCode(
    provider: SignInProvider,
    signal: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const label = PROVIDER_LABEL[provider];
    const attempt = (): Promise<{ response: Response; value: unknown }> =>
      this._post(
        this._startEndpoint,
        signal,
        BROKER_REQUEST_TIMEOUT_MS,
        "cs-control device authorization request timed out.",
        JSON.stringify({ provider }),
      );
    let { response, value } = await attempt();
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response, 1);
      await this._sleep(retryAfter * 1000, signal);
      ({ response, value } = await attempt());
      if (response.status === 429) {
        throw new Error(
          `cs-control is rate limiting sign-in attempts; try again in ${retryAfter}s.`,
        );
      }
    }
    if (!response.ok) throw brokerFailure(label, response.status, value);
    if (
      response.status !== 200 ||
      !exactKeys(value, [
        "handle",
        "userCode",
        "verificationUri",
        "expiresInSeconds",
        "intervalSeconds",
      ]) ||
      typeof value.handle !== "string" ||
      !TOKEN_43.test(value.handle) ||
      typeof value.userCode !== "string" ||
      !value.userCode ||
      typeof value.verificationUri !== "string" ||
      !boundedInteger(value.expiresInSeconds, 1, 3600) ||
      !boundedInteger(value.intervalSeconds, 1, 60)
    ) {
      throw new Error("cs-control returned an invalid device authorization.");
    }
    return {
      label,
      handle: value.handle,
      userCode: value.userCode,
      verificationUri: safeVerificationUri(value.verificationUri, label),
      expiresInSeconds: value.expiresInSeconds,
      intervalSeconds: value.intervalSeconds,
    };
  }

  private async _pollForToken(
    authorization: DeviceAuthorization,
    signal: AbortSignal,
  ): Promise<TokenResult> {
    let interval = authorization.intervalSeconds * 1000;
    const deadline = this._now() + authorization.expiresInSeconds * 1000;
    while (this._now() < deadline) {
      await this._sleep(interval, signal);
      const { response, value } = await this._post(
        `${this._pollEndpoint}${authorization.handle}`,
        signal,
        BROKER_REQUEST_TIMEOUT_MS,
        "cs-control device poll request timed out.",
      );
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (boundedInteger(retryAfter, 1, 60)) {
          interval = Math.max(retryAfter, authorization.intervalSeconds) * 1000;
        }
        continue;
      }
      if (!response.ok) {
        throw brokerFailure(authorization.label, response.status, value);
      }
      if (response.status === 202) {
        if (
          !exactKeys(value, ["status", "intervalSeconds"]) ||
          value.status !== "pending" ||
          !boundedInteger(value.intervalSeconds, 1, 60)
        ) {
          throw new Error("cs-control returned an invalid pending response.");
        }
        interval = value.intervalSeconds * 1000;
        continue;
      }
      const github = isPlainObject(value) && value.scheme === "github";
      if (
        response.status !== 200 ||
        !exactKeys(value, [
          "status",
          "scheme",
          "accessToken",
          ...(github ? [] : ["idToken"]),
          "expiresInSeconds",
        ]) ||
        value.status !== "complete" ||
        (value.scheme !== "Bearer" && value.scheme !== "github") ||
        typeof value.accessToken !== "string" ||
        !value.accessToken ||
        (!github && (typeof value.idToken !== "string" || !value.idToken)) ||
        !boundedInteger(value.expiresInSeconds, 1, 86400)
      ) {
        throw new Error("cs-control token response was invalid.");
      }
      return {
        scheme: value.scheme,
        accessToken: value.accessToken,
        ...(github ? {} : { idToken: value.idToken as string }),
        expiresInSeconds: value.expiresInSeconds,
      };
    }
    throw new Error(`${authorization.label} device sign-in expired.`);
  }

  private async _post(
    endpoint: string,
    signal: AbortSignal,
    timeoutMilliseconds: number,
    timeoutMessage: string,
    payload?: string,
  ): Promise<{ response: Response; value: unknown }> {
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), timeoutMilliseconds);
    try {
      const response = await this._fetch(endpoint, {
        method: "POST",
        ...(payload
          ? { body: payload, headers: { "Content-Type": "application/json" } }
          : {}),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([signal, timeout.signal]),
      });
      if (response.redirected || !jsonContentType(response)) {
        void response.body?.cancel();
        throw new Error("cs-control returned an invalid device response.");
      }
      const body = await readBoundedBody(response);
      if (!body) {
        throw new Error("cs-control returned an invalid device response.");
      }
      try {
        return { response, value: JSON.parse(body) };
      } catch {
        throw new Error("cs-control returned invalid JSON.");
      }
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted) {
        throw new Error(timeoutMessage);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }
}

function brokerFailure(label: string, status: number, value: unknown): Error {
  switch ((value as any)?.error?.code) {
    case "authorization_denied":
      return new Error(`${label} sign-in was denied.`);
    case "authorization_expired":
      return new Error(`${label} device sign-in expired.`);
    default:
      return new Error(`cs-control device authorization failed (${status}).`);
  }
}

function safeVerificationUri(value: string, label: string): string {
  const invalid = `${label} returned an invalid verification URI.`;
  const uri = parseUrl(value, invalid);
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) {
    throw new Error(invalid);
  }
  return uri.toString();
}

function retryAfterSeconds(response: Response, fallback: number): number {
  const value = Number(response.headers.get("Retry-After"));
  return boundedInteger(value, 1, 60) ? value : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
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
    if (bytes > MAX_BROKER_BODY) {
      await reader.cancel();
      throw new Error("cs-control returned an oversized device response.");
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

const abortableSleep = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = (): void => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
