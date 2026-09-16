// Runs the Microsoft device-code flow against cs-control's OAuth broker. The
// token is held in per-tab sessionStorage so it survives the session's own
// navigation. Every broker response is validated strictly against its expected
// shape.
import { PageConfig } from "@jupyterlab/coreutils";
import {
  TOKEN_43,
  exactKeys,
  isPlainObject,
  parseUrl,
  validControlApiUrl,
  type OAuthCredentials,
} from "./Common";
import { showDeviceCodeDialog } from "./DeviceCodeDialog";

const MAX_BROKER_BODY = 64 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 15 * 1000;

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
): { credentials: OAuthCredentials; expiresAt: number } | undefined {
  const raw = sessionStorage.getItem(SIGN_IN_KEY);
  if (!raw) return undefined;
  try {
    const { accessToken, idToken, expiresAt } = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    if (
      typeof accessToken !== "string" ||
      typeof idToken !== "string" ||
      !(typeof expiresAt === "number" && expiresAt > now)
    ) {
      throw new Error("stored credentials are unusable");
    }
    return { credentials: { accessToken, idToken }, expiresAt };
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
      this._expiresAt = stored.expiresAt;
    }
  }

  get account(): string | undefined {
    return this._credentials && accountFromIdToken(this._credentials.idToken);
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
    this._expiresAt = 0;
    sessionStorage.removeItem(SIGN_IN_KEY);
  }

  interactiveLogin(): Promise<OAuthCredentials> {
    if (!this._interaction) {
      const controller = new AbortController();
      const promise = this._interactiveLogin(controller.signal).finally(() => {
        this._interaction = undefined;
      });
      this._interaction = { promise, controller };
    }
    return this._interaction.promise;
  }

  private async _interactiveLogin(
    signal: AbortSignal,
  ): Promise<OAuthCredentials> {
    try {
      const authorization = await this._requestDeviceCode(signal);
      const dialog = showDeviceCodeDialog(authorization, () =>
        this._interaction?.controller.abort(),
      );
      try {
        const result = await this._pollForToken(authorization, signal);
        this._credentials = {
          accessToken: result.accessToken,
          idToken: result.idToken,
        };
        this._expiresAt = this._now() + result.expiresInSeconds * 1000;
        sessionStorage.setItem(
          SIGN_IN_KEY,
          JSON.stringify({ ...this._credentials, expiresAt: this._expiresAt }),
        );
        return { ...this._credentials };
      } finally {
        dialog.close();
      }
    } catch (error) {
      if (signal.aborted) throw new Error("Microsoft sign-in was cancelled.");
      throw error;
    }
  }

  private async _requestDeviceCode(
    signal: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const attempt = (): Promise<{ response: Response; value: unknown }> =>
      this._post(
        this._startEndpoint,
        signal,
        BROKER_REQUEST_TIMEOUT_MS,
        "cs-control device authorization request timed out.",
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
    if (!response.ok) throw brokerFailure(response.status, value);
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
      handle: value.handle,
      userCode: value.userCode,
      verificationUri: safeVerificationUri(value.verificationUri),
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
      if (!response.ok) throw brokerFailure(response.status, value);
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
      if (
        response.status !== 200 ||
        !exactKeys(value, [
          "status",
          "accessToken",
          "idToken",
          "expiresInSeconds",
        ]) ||
        value.status !== "complete" ||
        typeof value.accessToken !== "string" ||
        !value.accessToken ||
        typeof value.idToken !== "string" ||
        !value.idToken ||
        !boundedInteger(value.expiresInSeconds, 1, 86400)
      ) {
        throw new Error("cs-control token response was invalid.");
      }
      return {
        accessToken: value.accessToken,
        idToken: value.idToken,
        expiresInSeconds: value.expiresInSeconds,
      };
    }
    throw new Error("Microsoft device sign-in expired.");
  }

  private async _post(
    endpoint: string,
    signal: AbortSignal,
    timeoutMilliseconds: number,
    timeoutMessage: string,
  ): Promise<{ response: Response; value: unknown }> {
    const timeout = new AbortController();
    const timer = window.setTimeout(() => timeout.abort(), timeoutMilliseconds);
    try {
      const response = await this._fetch(endpoint, {
        method: "POST",
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

function brokerFailure(status: number, value: unknown): Error {
  switch ((value as any)?.error?.code) {
    case "authorization_denied":
      return new Error("Microsoft sign-in was denied.");
    case "authorization_expired":
      return new Error("Microsoft device sign-in expired.");
    default:
      return new Error(`cs-control device authorization failed (${status}).`);
  }
}

function safeVerificationUri(value: string): string {
  const invalid = "Microsoft returned an invalid verification URI.";
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
