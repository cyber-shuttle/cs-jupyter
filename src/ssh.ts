// SSH interactive auth end to end: the token-bearing WebSocket connector, the
// terminal that renders an operation's transcript, and the dock that hosts it
// during sign-in. A WebSocket cannot carry an Authorization header, so the
// ID token travels as a subprotocol, refreshed on each open. The console is
// credential-blind, passing prompts and replies straight through to SSH, and
// the dock attaches to document.body rather than the session detail dialog so
// closing that dialog cannot destroy it.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Widget } from "@lumino/widgets";
import {
  assertSecureOrLoopback,
  parseUrl,
  type ITokenProvider,
  base64UrlEncode,
  type Narrow,
} from "./Common";
import type { ServerFrame as WireServerFrame } from "./api/frames";
import { element } from "./dom";

const CYBERSHUTTLE_WEBSOCKET_PROTOCOL = "cybershuttle.v1";
const CYBERSHUTTLE_BEARER_PROTOCOL_PREFIX = "bearer.";
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const TOKEN_CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f]/u;

export type OAuthWebSocketConnector = () => Promise<WebSocket>;

export type WebSocketConstructor = new (
  url: string,
  protocols: string[],
) => WebSocket;

export class OAuthWebSocketFactory {
  private readonly _controlOrigin: string;

  constructor(
    private readonly _auth: ITokenProvider,
    controlOrigin: string,
    private readonly _WebSocket: WebSocketConstructor = WebSocket,
  ) {
    const httpOrigin = new URL(controlOrigin);
    httpOrigin.protocol = httpOrigin.protocol === "https:" ? "wss:" : "ws:";
    this._controlOrigin = new URL(
      validateWebSocketUrl(httpOrigin.toString()),
    ).origin;
  }

  async open(rawUrl: string): Promise<WebSocket> {
    const url = validateWebSocketUrl(rawUrl);
    if (new URL(url).origin !== this._controlOrigin) {
      throw new Error(
        "CyberShuttle blocked a WebSocket outside the configured control origin.",
      );
    }
    const credentials = await this._auth.acquireToken();
    return new this._WebSocket(url, [
      CYBERSHUTTLE_WEBSOCKET_PROTOCOL,
      `${CYBERSHUTTLE_BEARER_PROTOCOL_PREFIX}${encodeAccessToken(credentials.idToken)}`,
    ]);
  }
}

function encodeAccessToken(token: string): string {
  if (!token || TOKEN_CONTROL_OR_WHITESPACE.test(token)) {
    throw new Error(
      "CyberShuttle delegated token contains invalid characters.",
    );
  }
  const bytes = new TextEncoder().encode(token);
  if (bytes.byteLength > MAX_ACCESS_TOKEN_BYTES) {
    throw new Error("CyberShuttle delegated token is too large.");
  }
  return base64UrlEncode(bytes);
}

function validateWebSocketUrl(raw: string): string {
  const url = parseUrl(raw, "CyberShuttle WebSocket URL is invalid.");
  assertSecureOrLoopback(
    url,
    "wss:",
    "ws:",
    "CyberShuttle WebSocket URL must use WSS or loopback WS without credentials, query, or fragment.",
  );
  return url.toString();
}

const MAX_ANNOUNCEMENT_LENGTH = 512;

export interface ISshOperationCallbacks {
  failed: (message: string) => void;
  ready?: () => void;
  status?: (message: string) => void;
}

export interface ISshOperationConsole {
  readonly node: HTMLElement;
  start(
    connect: OAuthWebSocketConnector,
    callbacks: ISshOperationCallbacks,
  ): void;
  complete(message: string): void;
  focus(): void;
  dispose(): void;
}

type ServerFrame = Narrow<WireServerFrame, { type: "ready" | "exit" }>;

export class SshOperationConsole implements ISshOperationConsole {
  readonly node = element("section", "", "csSshAuthTranscript", {
    role: "region",
    "aria-label": "SSH operation console",
  });
  private _terminalHost = element("div", "", "csSshOperationTerminal", {
    "aria-label": "SSH operation output",
  });
  private _terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    screenReaderMode: true,
    disableStdin: true,
    fontFamily: "var(--jp-code-font-family)",
    fontSize: 13,
    theme: { background: "#111827", foreground: "#f3f4f6" },
  });
  private _fitAddon = new FitAddon();
  private _socket: WebSocket | undefined;
  private _resizeObserver: ResizeObserver | undefined;
  private _disposed = false;
  private _epoch = 0;
  private _callbacks: ISshOperationCallbacks | undefined;
  private _encoder = new TextEncoder();
  private _decoder = new TextDecoder();
  private _finished = false;

  constructor() {
    this.node.appendChild(this._terminalHost);
    this._terminal.loadAddon(this._fitAddon);
    this._terminal.open(this._terminalHost);
    this._terminal.onData((data) => {
      if (this._socket?.readyState === WebSocket.OPEN) {
        this._socket.send(this._encoder.encode(data));
      }
    });
    this._terminal.onResize(({ cols, rows }) => {
      if (this._socket?.readyState === WebSocket.OPEN) {
        this._socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    document.addEventListener("keydown", this._enter, true);
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._fit());
      this._resizeObserver.observe(this.node);
    }
    requestAnimationFrame(() => this._fit());
  }

  start(
    connect: OAuthWebSocketConnector,
    callbacks: ISshOperationCallbacks,
  ): void {
    this._closeSocket();
    this._callbacks = callbacks;
    this._finished = false;
    this._terminal.options.disableStdin = false;
    this.node.hidden = false;
    this._say("Opening interactive SSH authentication…");
    this._connect(connect);
  }

  complete(message: string): void {
    this._finished = true;
    this._epoch++;
    this._say(boundedAnnouncement(message, "Operation complete."));
    this.node.hidden = true;
    this._closeSocket();
  }

  focus(): void {
    this._terminal.focus();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._epoch++;
    this._closeSocket();
    document.removeEventListener("keydown", this._enter, true);
    this._resizeObserver?.disconnect();
    this._terminal.dispose();
    this.node.remove();
  }

  private _connect(connect: OAuthWebSocketConnector): void {
    const epoch = ++this._epoch;
    void connect().then(
      (socket) => {
        if (this._disposed || epoch !== this._epoch) {
          socket.close();
          return;
        }
        socket.binaryType = "arraybuffer";
        this._decoder = new TextDecoder();
        this._socket = socket;
        socket.onopen = () => {
          if (socket.protocol !== CYBERSHUTTLE_WEBSOCKET_PROTOCOL) {
            socket.close(
              1002,
              "CyberShuttle WebSocket protocol negotiation failed",
            );
            this._fail(
              "cs-plane did not negotiate the required CyberShuttle WebSocket protocol.",
            );
            return;
          }
          this._say(
            "Respond to the prompts below. Passwords and verification codes go straight to SSH and are not stored.",
          );
          this._fit();
          this.focus();
        };
        socket.onmessage = (event) => this._message(event.data);
        socket.onerror = () => this._fail("SSH operation connection failed.");
        socket.onclose = (event) =>
          this._fail(
            boundedAnnouncement(
              event.reason,
              "SSH operation connection closed.",
            ),
          );
      },
      (error) => {
        if (!this._disposed && epoch === this._epoch) {
          this._fail(
            boundedAnnouncement(
              error instanceof Error ? error.message : undefined,
              "SSH operation connection failed.",
            ),
          );
        }
      },
    );
  }

  private _message(raw: unknown): void {
    if (raw instanceof ArrayBuffer) {
      const output = this._decoder.decode(new Uint8Array(raw), {
        stream: true,
      });
      if (output) this._terminal.write(output);
      return;
    }
    if (typeof raw !== "string") {
      this._fail("cs-plane returned an invalid SSH operation frame.");
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      this._fail("cs-plane returned an invalid SSH operation frame.");
      return;
    }
    switch (frame.type) {
      case "ready":
        this._finished = true;
        this._say("SSH authentication succeeded.");
        this._callbacks?.ready?.();
        break;
      case "exit":
        this._fail(
          boundedAnnouncement(
            frame.message,
            `SSH operation exited${frame.code === undefined ? "" : ` with status ${frame.code}`}.`,
          ),
        );
        break;
      default:
        this._fail("cs-plane returned an unknown SSH operation frame.");
    }
  }

  private _say(message: string): void {
    this._callbacks?.status?.(message);
  }

  private _enter = (event: KeyboardEvent): void => {
    if (
      event.key !== "Enter" ||
      this._finished ||
      !this.node.contains(event.target as Node)
    ) {
      return;
    }
    event.stopPropagation();
    this._terminal.input("\r");
  };

  private _fail(message: string): void {
    if (this._finished) {
      return;
    }
    this._finished = true;
    this._say(message);
    this._terminal.options.disableStdin = true;
    this._callbacks?.failed(message);
  }

  private _closeSocket(): void {
    const socket = this._socket;
    this._socket = undefined;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  private _fit(): void {
    if (this._disposed || !this.node.isConnected) {
      return;
    }
    try {
      this._fitAddon.fit();
    } catch {}
  }
}

function boundedAnnouncement(value: unknown, fallback: string): string {
  const message = typeof value === "string" ? value.trim() : "";
  return (message || fallback).slice(0, MAX_ANNOUNCEMENT_LENGTH);
}

export class SshLoginDock extends Widget {
  private _console: ISshOperationConsole | undefined;
  private _pending: ((reason: Error) => void) | undefined;
  private _status = element("div", "", "csSshAuthStatus", {
    role: "status",
  });

  constructor(
    private _consoleFactory: () => ISshOperationConsole = () =>
      new SshOperationConsole(),
  ) {
    super();
    this.addClass("csSshLoginDock");
    this.node.appendChild(this._status);
    this.hide();
  }

  login(alias: string, connect: OAuthWebSocketConnector): Promise<void> {
    this._settle(new Error("Superseded by another SSH login."));
    this._status.textContent = `${alias} is asking for credentials.`;
    this.show();
    if (!this._console) {
      this._console = this._consoleFactory();
      this.node.appendChild(this._console.node);
    }
    const console = this._console;
    return new Promise<void>((resolve, reject) => {
      this._pending = reject;
      const current = (): boolean => this._pending === reject;
      const done = (message: string): boolean => {
        if (!current()) return false;
        this._pending = undefined;
        this._status.textContent = message;
        console.complete(message);
        this.hide();
        return true;
      };
      console.start(connect, {
        ready: () => done(`Signed in to ${alias}.`) && resolve(),
        failed: (message) => done(message) && reject(new Error(message)),
        status: (message) => {
          if (current()) this._status.textContent = message;
        },
      });
      requestAnimationFrame(() => {
        if (!current()) return;
        this.node.scrollIntoView?.({ block: "nearest" });
        console.focus();
      });
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._settle(new Error("SSH login dismissed."));
    this._console?.dispose();
    super.dispose();
  }

  private _settle(reason: Error): void {
    const reject = this._pending;
    this._pending = undefined;
    reject?.(reason);
  }
}
