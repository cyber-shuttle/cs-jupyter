import { PageConfig } from "@jupyterlab/coreutils";
import { assertSecureOrLoopback, isPlainObject } from "./Common";

const MAX_BROKER_BODY = 64 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 15 * 1000;

const abortError = (): DOMException =>
  new DOMException("Aborted", "AbortError");

export class AuthInteractionRequiredError extends Error {
  readonly code = "interaction_required";

  constructor(message = "Sign in to CyberShuttle to continue.") {
    super(message);
    this.name = "AuthInteractionRequiredError";
  }
}

export class AuthInteractionCancelledError extends Error {
  readonly code = "interaction_cancelled";

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

// Tokens live only in memory: never storage, never a URL, never a log.
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
  }

  async acquireToken(): Promise<OAuthCredentials> {
    if (!this._credentials || this._now() >= this._expiresAt) {
      this._credentials = undefined;
      this._expiresAt = 0;
      throw new AuthInteractionRequiredError();
    }
    return { ...this._credentials };
  }

  invalidateToken(): void {
    this._credentials = undefined;
    this._expiresAt = 0;
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
      const expiresAt =
        this._now() + secondsToMilliseconds(authorization.expiresInSeconds);
      const modal = showDeviceCodeModal(authorization, () =>
        this._interaction?.controller.abort(),
      );
      try {
        const result = await this._pollForToken(
          authorization,
          expiresAt,
          signal,
        );
        this._credentials = {
          accessToken: result.accessToken,
          idToken: result.idToken,
        };
        this._expiresAt =
          this._now() + secondsToMilliseconds(result.expiresInSeconds);
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
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<TokenResult> {
    let interval = secondsToMilliseconds(authorization.intervalSeconds);
    while (this._now() < expiresAt) {
      await this._sleep(Math.min(interval, expiresAt - this._now()), signal);
      if (this._now() >= expiresAt) break;
      const remaining = expiresAt - this._now();
      const expiresFirst = remaining <= BROKER_REQUEST_TIMEOUT_MS;
      const { response, value } = await this._post(
        `${this._pollEndpoint}${authorization.handle}`,
        signal,
        Math.min(BROKER_REQUEST_TIMEOUT_MS, remaining),
        expiresFirst
          ? "Microsoft device sign-in expired."
          : "cs-control device poll request timed out.",
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
        interval = secondsToMilliseconds(value.intervalSeconds);
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
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Timed out", "TimeoutError"));
    }, timeoutMilliseconds);
    try {
      const response = await rejectOnAbort(
        this._fetch(endpoint, {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.redirected || !jsonContentType(response)) {
        void response.body?.cancel();
        throw new Error("cs-control returned an invalid device response.");
      }
      const body = await readBoundedBody(response, controller.signal);
      if (body.length === 0) {
        throw new Error("cs-control returned an invalid device response.");
      }
      try {
        return { response, value: JSON.parse(body) };
      } catch {
        throw new Error("cs-control returned invalid JSON.");
      }
    } catch (error) {
      if (timedOut && !signal.aborted) throw new Error(timeoutMessage);
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
}

export function validControlApiUrl(configured: string): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "cybershuttleControlApiUrl must be an absolute control API URL.",
    );
  }
  const invalid =
    "cybershuttleControlApiUrl is invalid; it must use HTTPS or loopback HTTP without credentials, query, or fragment.";
  if (!configured) {
    throw new Error(invalid);
  }
  assertSecureOrLoopback(url, "https:", "http:", invalid);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function exactKeys(
  value: unknown,
  expected: string[],
): value is Record<string, any> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => key === actual[index])
  );
}

function brokerFailure(status: number, value: unknown): Error {
  if (
    !exactKeys(value, ["error"]) ||
    !exactKeys(value.error, ["code", "message"]) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string"
  ) {
    return new Error(`cs-control device authorization failed (${status}).`);
  }
  switch (value.error.code) {
    case "authorization_denied":
      return new Error("Microsoft sign-in was denied.");
    case "authorization_expired":
      return new Error("Microsoft device sign-in expired.");
    default:
      return new Error(`cs-control device authorization failed (${status}).`);
  }
}

function safeVerificationUri(value: string): string {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("Microsoft returned an invalid verification URI.");
  }
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) {
    throw new Error("Microsoft returned an invalid verification URI.");
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

function secondsToMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("cs-control returned an invalid device response.");
  }
  return milliseconds;
}

function jsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return (
    contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("cs-control returned an invalid device response.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let size = 0;
  let rejectAborted: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectAborted?.(abortError());
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BROKER_BODY) {
        void reader
          .cancel("response body exceeded limit")
          .catch(() => undefined);
        throw new Error("cs-control returned an invalid device response.");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("cs-control returned invalid JSON.");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A canceled read can still be settling after the abort race completes.
    }
  }
}

function rejectOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function showDeviceCodeModal(
  authorization: DeviceAuthorization,
  cancel: () => void,
): { close(): void } {
  const activeElement = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "csDeviceCodeOverlay";
  const dialog = document.createElement("section");
  dialog.className = "csDeviceCodeDialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = document.createElement("h2");
  title.id = `cs-device-code-title-${crypto.randomUUID()}`;
  title.textContent = "Sign in to Microsoft";
  dialog.setAttribute("aria-labelledby", title.id);
  const instructions = document.createElement("p");
  instructions.id = `cs-device-code-instructions-${crypto.randomUUID()}`;
  instructions.textContent =
    "Open the Microsoft sign-in page and enter this one-time code:";
  dialog.setAttribute("aria-describedby", instructions.id);
  const code = document.createElement("code");
  code.className = "csDeviceCode";
  code.textContent = authorization.userCode;
  code.setAttribute("aria-label", `Device code ${authorization.userCode}`);
  const status = document.createElement("span");
  status.className = "csDeviceCodeStatus";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "csDeviceCodeActions";
  const open = document.createElement("a");
  open.className = "jp-mod-accept jp-Button";
  open.href = authorization.verificationUri;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.referrerPolicy = "no-referrer";
  open.textContent = "Open sign-in page";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "jp-Button";
  copy.textContent = "Copy code";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      status.textContent = "Code copied.";
    } catch {
      status.textContent = "Could not copy the code.";
    }
  };
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "jp-Button";
  cancelButton.textContent = "Cancel";
  cancelButton.onclick = cancel;
  actions.append(open, copy, cancelButton);
  dialog.append(title, instructions, code, status, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const focusable = [open, copy, cancelButton];
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Tab") {
      const current = focusable.indexOf(
        document.activeElement as HTMLAnchorElement | HTMLButtonElement,
      );
      const next = event.shiftKey
        ? current <= 0
          ? focusable.length - 1
          : current - 1
        : current >= focusable.length - 1
          ? 0
          : current + 1;
      event.preventDefault();
      focusable[next].focus();
    }
  };
  dialog.addEventListener("keydown", onKeyDown);
  open.focus();

  return {
    close: () => {
      dialog.removeEventListener("keydown", onKeyDown);
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
  rejectOnAbort(
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
    signal,
  );
