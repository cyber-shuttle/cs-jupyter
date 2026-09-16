// The SSH login console fails closed unless cs-control negotiates the
// CyberShuttle WebSocket subprotocol. It must swallow the Enter key itself,
// since the hosting dialog would otherwise close on the same keystroke.
import type { ITerminalOptions } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Terminal {
    options: ITerminalOptions;
    private _data: (value: string) => void = () => {};
    private _resize: (value: { cols: number; rows: number }) => void = () => {};
    constructor(options: ITerminalOptions) {
      this.options = options;
      terminals.push(this);
    }
    loadAddon(_addon: unknown): void {}
    open(_node: HTMLElement): void {}
    focus(): void {}
    dispose(): void {}
    write(_value: string): void {}
    onData(callback: (value: string) => void): void {
      this._data = callback;
    }
    onResize(callback: (value: { cols: number; rows: number }) => void): void {
      this._resize = callback;
    }
    emitData(value: string): void {
      this._data(value);
    }
    emitResize(cols: number, rows: number): void {
      this._resize({ cols, rows });
    }
    input(value: string): void {
      this._data(value);
    }
  }
  const terminals: Terminal[] = [];
  return { Terminal, terminals };
});

vi.mock("@xterm/xterm", () => ({ Terminal: mocks.Terminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  protocol = "cybershuttle.v1";
  binaryType: BinaryType = "blob";
  sent: Array<string | ArrayBufferView> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(value: string | ArrayBufferView): void {
    this.sent.push(value);
  }
  close(): void {
    this.closed = true;
  }
  message(value: object): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  binary(value: Uint8Array): void {
    this.onmessage?.({ data: Uint8Array.from(value).buffer });
  }
}
const sockets: FakeSocket[] = [];
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: FakeSocket,
});

import type { OAuthWebSocketConnector } from "../src/OAuthWebSocket";
import { SshOperationConsole } from "../src/SshOperationConsole";

const connect =
  (url: string): OAuthWebSocketConnector =>
  async () =>
    new FakeSocket(url) as unknown as WebSocket;

describe("SSH operation console protocol", () => {
  beforeEach(() => {
    sockets.length = 0;
    mocks.terminals.length = 0;
  });

  it.each(["", "other.protocol"])(
    "fails closed when cs-control negotiates %j",
    async (protocol) => {
      const error = vi.fn();
      const console = new SshOperationConsole();
      console.start(connect("ws://localhost/ssh/delta/auth"), {
        failed: error,
      });
      await Promise.resolve();
      const socket = sockets[0];
      socket.protocol = protocol;
      socket.onopen?.();
      expect(socket.closed).toBe(true);
      expect(error).toHaveBeenCalledWith(
        "cs-control did not negotiate the required CyberShuttle WebSocket protocol.",
      );
      console.dispose();
    },
  );

  it("accepts input, resize and readiness without echoing the secret", async () => {
    const ready = vi.fn();
    const exit = vi.fn();
    const console = new SshOperationConsole();
    console.start(connect("ws://localhost/ssh/delta/auth"), {
      ready,
      failed: exit,
    });
    await Promise.resolve();
    const socket = sockets[0];
    const terminal = mocks.terminals[0];
    socket.binary(new TextEncoder().encode("Password: "));
    expect(terminal.options.screenReaderMode).toBe(true);
    expect(terminal.options.disableStdin).toBe(false);
    terminal.emitData("secret\r");
    expect(socket.sent).toHaveLength(1);
    expect(Array.from(socket.sent[0] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode("secret\r")),
    );
    terminal.emitResize(100, 30);
    expect(JSON.parse(socket.sent[1] as string)).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
    });
    socket.message({ type: "ready" });
    expect(ready).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    console.dispose();
  });

  it("delivers Enter that the hosting dialog would otherwise take", async () => {
    const console = new SshOperationConsole();
    document.body.appendChild(console.node);
    console.start(connect("ws://localhost/ssh/delta/auth"), {
      failed: vi.fn(),
    });
    await Promise.resolve();
    const socket = sockets[0];
    const dialog = vi.fn();
    document.addEventListener("keydown", dialog);
    console.node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    document.removeEventListener("keydown", dialog);
    expect(Array.from(socket.sent[0] as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode("\r")),
    );
    expect(dialog).not.toHaveBeenCalled();
    console.dispose();
  });
});
