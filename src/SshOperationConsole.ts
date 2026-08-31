import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  CYBERSHUTTLE_WEBSOCKET_PROTOCOL,
  type OAuthWebSocketConnector,
} from "./OAuthWebSocket";

const MAX_ANNOUNCEMENT_LENGTH = 512;

export interface ISshOperationCallbacks {
  failed: (message: string) => void;
  ready?: () => void;
  // The console owns the transcript and nothing else: what it is doing is said
  // once, where the rest of the operation says it.
  status?: (message: string) => void;
}

export interface ISshOperationConsole {
  readonly node: HTMLElement;
  start(
    connect: OAuthWebSocketConnector,
    callbacks: ISshOperationCallbacks,
  ): void;
  complete(message: string, collapse?: boolean): void;
  focus(): void;
  cancel(): void;
  dispose(): void;
}

export type SshOperationConsoleFactory = () => ISshOperationConsole;

type ServerFrame =
  | { type: "ready" }
  | { type: "exit"; code?: number; message?: string };

// Credential-blind: prompts and replies pass straight through to SSH.
export class SshOperationConsole implements ISshOperationConsole {
  readonly node = document.createElement("section");
  private _terminalHost = document.createElement("div");
  private _terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    screenReaderMode: true,
    disableStdin: true,
    fontFamily: "var(--jp-code-font-family)",
    fontSize: 13,
    theme: { background: "#111827", foreground: "#f3f4f6" },
  });
  private _fit = new FitAddon();
  private _socket: WebSocket | undefined;
  private _resizeObserver: ResizeObserver | undefined;
  private _disposed = false;
  private _generation = 0;
  private _callbacks: ISshOperationCallbacks | undefined;
  private _encoder = new TextEncoder();
  private _decoder = new TextDecoder();
  private _finished = false;

  constructor() {
    this.node.className = "csSshAuthSession";
    this.node.setAttribute("role", "region");
    this.node.setAttribute("aria-label", "SSH operation console");
    this._terminalHost.className = "csSshOperationTerminal";
    this._terminalHost.setAttribute("aria-label", "SSH operation output");
    this.node.appendChild(this._terminalHost);
    this._terminal.loadAddon(this._fit);
    this._terminal.open(this._terminalHost);
    this._terminal.onData((data) => {
      if (this._socket?.readyState === WebSocket.OPEN) {
        this._socket.send(this._encoder.encode(data));
      }
    });
    this._terminal.onResize(({ cols, rows }) =>
      this._send({ type: "resize", cols, rows }),
    );
    // The dialog that hosts this console claims Enter for its own buttons, and
    // it claims it from the document down, so the terminal never sees the one
    // key an OpenSSH prompt is waiting for. The console takes it back and
    // delivers it itself.
    document.addEventListener("keydown", this._enter, true);
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._fitAndReport());
      this._resizeObserver.observe(this.node);
    }
    requestAnimationFrame(() => this._fitAndReport());
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

  complete(message: string, collapse = true): void {
    this._finished = true;
    this._generation++;
    this._say(boundedAnnouncement(message, "Operation complete."));
    this.node.hidden = collapse;
    this._closeSocket();
  }

  focus(): void {
    this._terminal.focus();
  }

  cancel(): void {
    this._generation++;
    this._closeSocket();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._generation++;
    this._closeSocket();
    document.removeEventListener("keydown", this._enter, true);
    this._resizeObserver?.disconnect();
    this._terminal.dispose();
    this.node.remove();
  }

  private _connect(connect: OAuthWebSocketConnector): void {
    const generation = ++this._generation;
    void connect().then(
      (socket) => {
        if (this._disposed || generation !== this._generation) {
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
              "cs-control did not negotiate the required CyberShuttle WebSocket protocol.",
            );
            return;
          }
          this._say(
            "Respond to the prompts below. Passwords and verification codes go straight to SSH and are not stored.",
          );
          this._fitAndReport();
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
        if (!this._disposed && generation === this._generation) {
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
      this._fail("cs-control returned an invalid SSH operation frame.");
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      this._fail("cs-control returned an invalid SSH operation frame.");
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
        this._fail("cs-control returned an unknown SSH operation frame.");
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

  private _fitAndReport(): void {
    if (this._disposed || !this.node.isConnected) {
      return;
    }
    try {
      this._fit.fit();
    } catch {
      return;
    }
  }

  private _send(frame: object): void {
    if (this._socket?.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(frame));
    }
  }
}

function boundedAnnouncement(value: unknown, fallback = ""): string {
  const message = typeof value === "string" ? value.trim() : "";
  return (message || fallback).slice(0, MAX_ANNOUNCEMENT_LENGTH);
}

export const createSshOperationConsole: SshOperationConsoleFactory = () =>
  new SshOperationConsole();
