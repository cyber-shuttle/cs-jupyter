import { PageConfig } from "@jupyterlab/coreutils";
import {
  assertSecureOrLoopback,
  exactKeys,
  isPlainObject,
  parseUrl,
} from "./Common";
import { closeButton, element } from "./dom";

const MAX_BROKER_BODY = 64 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 15 * 1000;

export class AuthInteractionRequiredError extends Error {
  constructor(message = "Sign in to CyberShuttle to continue.") {
    super(message);
    this.name = "AuthInteractionRequiredError";
  }
}

export class AuthInteractionCancelledError extends Error {
  constructor(message = "Microsoft sign-in was cancelled.") {
    super(message);
    this.name = "AuthInteractionCancelledError";
  }
}

export interface OAuthCredentials {
  accessToken: string;
  idToken: string;
}

export interface IAuthClientOptions {
  controlApiUrl?: string;
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

const SESSION_KEY = "cybershuttle.oauth.v1";

const COPY_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5.6" y="5.6" width="8" height="8" rx="1.4" /><path d="M10.9 5.6V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.7" /></g></svg>`;
const CHECK_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.4 8.4 3 3 6.2-6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

// Display only: the control plane validates the token this is carved from, so
// nothing depends on the claim being trustworthy.
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

// Tokens survive a reload in per-tab session storage, never a URL or a log.
// Opening a runtime navigates, so a memory-only credential would force a
// device-code round trip every time.
function readStoredCredentials(
  now: number,
): { credentials: OAuthCredentials; expiresAt: number } | undefined {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return undefined;
  try {
    const { accessToken, idToken, expiresAt } = JSON.parse(raw) as Record<
      string,
      unknown
    >;
    // Any other shape puts `Bearer undefined` on the wire.
    if (
      typeof accessToken !== "string" ||
      typeof idToken !== "string" ||
      !(typeof expiresAt === "number" && expiresAt > now)
    ) {
      throw new Error("stored credentials are unusable");
    }
    return { credentials: { accessToken, idToken }, expiresAt };
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
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
    options: IAuthClientOptions = {},
    dependencies: IAuthClientDependencies = {},
  ) {
    const base = validControlApiUrl(
      options.controlApiUrl ??
        PageConfig.getOption("cybershuttleControlApiUrl"),
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
    sessionStorage.removeItem(SESSION_KEY);
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
      const modal = showDeviceCodeModal(authorization, () =>
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
          SESSION_KEY,
          JSON.stringify({ ...this._credentials, expiresAt: this._expiresAt }),
        );
        return { ...this._credentials };
      } finally {
        modal.close();
      }
    } catch (error) {
      if (signal.aborted) throw new AuthInteractionCancelledError();
      throw error;
    }
  }

  private async _requestDeviceCode(
    signal: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const { response, value } = await this._post(
      this._startEndpoint,
      signal,
      BROKER_REQUEST_TIMEOUT_MS,
      "cs-control device authorization request timed out.",
    );
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
      !/^[A-Za-z0-9_-]{43}$/.test(value.handle) ||
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
    // A broker answering 202 past the life it advertised would otherwise leave
    // the cached interaction promise unsettled for the tab.
    const deadline = this._now() + authorization.expiresInSeconds * 1000;
    while (this._now() < deadline) {
      await this._sleep(interval, signal);
      const { response, value } = await this._post(
        `${this._pollEndpoint}${authorization.handle}`,
        signal,
        BROKER_REQUEST_TIMEOUT_MS,
        "cs-control device poll request timed out.",
      );
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

export function validControlApiUrl(configured: string): string {
  const url = parseUrl(
    configured,
    "cybershuttleControlApiUrl must be an absolute control API URL.",
  );
  assertSecureOrLoopback(
    url,
    "https:",
    "http:",
    "cybershuttleControlApiUrl is invalid; it must use HTTPS or loopback HTTP without credentials, query, or fragment.",
  );
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
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

// Bounds the body as it arrives; measuring after buffering lets a broker answer
// with gigabytes before the cap is read.
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

function showDeviceCodeModal(
  authorization: DeviceAuthorization,
  cancel: () => void,
): { close(): void } {
  const activeElement = document.activeElement;
  const overlay = element("dialog", "", "csDeviceCodeOverlay");
  const dialog = element("section", "", "csDeviceCodeDialog");
  const title = element("h2", "Sign in to Microsoft");
  title.id = `cs-device-code-title-${crypto.randomUUID()}`;
  overlay.setAttribute("aria-labelledby", title.id);
  const instructions = element(
    "p",
    "Open the Microsoft sign-in page and enter this one-time code:",
  );
  instructions.id = `cs-device-code-instructions-${crypto.randomUUID()}`;
  overlay.setAttribute("aria-describedby", instructions.id);
  const code = element("code", authorization.userCode, "csDeviceCode");
  code.setAttribute("aria-label", `Device code ${authorization.userCode}`);

  // The copy control answers in place, with a checkmark where the icon was.
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "csDeviceCodeCopy";
  copy.innerHTML = COPY_GLYPH;
  // Label and tooltip say the same thing, so a failure leaves nothing stale.
  const describeCopy = (text: string): void => {
    copy.title = text;
    copy.setAttribute("aria-label", text);
  };
  describeCopy("Copy code");
  let copyReset: ReturnType<typeof setTimeout> | undefined;
  copy.onclick = async () => {
    clearTimeout(copyReset);
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      copy.innerHTML = CHECK_GLYPH;
      copy.classList.add("csDeviceCodeCopied");
      describeCopy("Code copied");
      copyReset = setTimeout(() => {
        copy.innerHTML = COPY_GLYPH;
        copy.classList.remove("csDeviceCodeCopied");
        describeCopy("Copy code");
      }, 2000);
    } catch {
      copy.innerHTML = COPY_GLYPH;
      copy.classList.remove("csDeviceCodeCopied");
      describeCopy("Could not copy the code");
    }
  };
  const codeRow = element("div", "", "csDeviceCodeRow");
  codeRow.append(code, copy);

  const actions = element("div", "", "csDeviceCodeActions");
  const open = document.createElement("a");
  open.className = "csPrimaryButton csDeviceCodeOpen";
  open.href = authorization.verificationUri;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.referrerPolicy = "no-referrer";
  open.textContent = "Open sign-in page";
  // The answer arrives on the other device, so the button stops inviting clicks
  // and reports what it is now doing.
  open.onclick = () => {
    open.classList.add("csDeviceCodeWaiting");
    open.textContent = "";
    open.append(
      element("span", "", "csSpinner"),
      document.createTextNode("Waiting…"),
    );
  };
  actions.appendChild(open);

  dialog.append(closeButton(cancel), title, instructions, codeRow, actions);
  overlay.appendChild(dialog);
  // Modal semantics, focus containment, Escape and an inert backdrop come from
  // showModal; document.body keeps a themed container from clipping the overlay.
  document.body.appendChild(overlay);
  overlay.addEventListener("cancel", cancel);
  overlay.showModal();
  open.focus();

  return {
    close: () => {
      overlay.remove();
      if (activeElement instanceof HTMLElement && activeElement.isConnected) {
        activeElement.focus();
      }
    },
  };
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
    // The poll sleeps on one long-lived signal, so a listener left behind by
    // every normal timer is an unbounded leak.
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
