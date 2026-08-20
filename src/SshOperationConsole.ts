import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  CYBERSHUTTLE_WEBSOCKET_PROTOCOL,
  type OAuthWebSocketConnector,
} from "./OAuthWebSocket";

const MAX_ANNOUNCEMENT_LENGTH = 512;

const INSTRUCTIONS =
  "Respond to OpenSSH prompts below. Passwords and verification codes are sent directly to SSH and are not stored.";

export interface ISshOperationCallbacks {
  failed: (message: string) => void;
  ready?: () => void;
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
  private _instructions = document.createElement("p");
  private _status = document.createElement("div");
  private _details = document.createElement("details");
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
    this._instructions.className = "csSshAuthInstructions";
    this._status.className = "csSshAuthStatus";
    this._status.setAttribute("role", "status");
    this._status.setAttribute("aria-live", "polite");
    this._status.setAttribute("aria-atomic", "true");
    const summary = document.createElement("summary");
    summary.textContent = "Operation details";
    this._details.className = "csSshOperationDetails";
    this._details.open = true;
    this._terminalHost.className = "csSshOperationTerminal";
    this._terminalHost.setAttribute("aria-label", "SSH operation output");
    this._details.append(summary, this._terminalHost);
    this.node.append(this._instructions, this._status, this._details);
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
    this._instructions.textContent = INSTRUCTIONS;
    this._status.textContent = "Opening interactive SSH authentication…";
    this._details.open = true;
    this._connect(connect);
  }

  complete(message: string, collapse = true): void {
    this._finished = true;
    this._generation++;
    this._status.textContent = boundedAnnouncement(
      message,
      "Operation complete.",
    );
    this._details.open = !collapse;
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
          if (!this._current(socket, generation)) return;
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
          this._status.textContent =
            "SSH terminal connected. Respond to the prompt below.";
          this._fitAndReport();
          this.focus();
        };
        socket.onmessage = (event) => {
          if (this._current(socket, generation)) this._message(event.data);
        };
        socket.onerror = () => {
          if (this._current(socket, generation) && !this._finished) {
            this._fail("SSH operation connection failed.");
          }
        };
        socket.onclose = (event) => {
          if (this._current(socket, generation) && !this._finished) {
            this._fail(
              boundedAnnouncement(
                event.reason,
                "SSH operation connection closed.",
              ),
            );
          }
        };
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
        this._status.textContent = "SSH authentication succeeded.";
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

  private _fail(message: string): void {
    if (this._disposed || this._finished) {
      return;
    }
    this._finished = true;
    this._status.textContent = message;
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

  private _current(socket: WebSocket, generation: number): boolean {
    return (
      !this._disposed &&
      this._socket === socket &&
      this._generation === generation
    );
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
