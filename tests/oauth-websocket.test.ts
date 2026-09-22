// Covers OAuthWebSocketFactory: URL construction, subprotocol encoding, and
// rejection of malformed tokens or URLs. The multibyte token test checks that
// the subprotocol carries base64url of UTF-8 bytes, not the raw string.
import { fakeAuth } from "./fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../src/ControlClient";
import { OAuthWebSocketFactory, type WebSocketConstructor } from "../src/ssh";

class FakeSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = this.CONNECTING;
  readonly bufferedAmount = 0;
  readonly extensions = "";
  binaryType: BinaryType = "blob";
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  protocol = "";
  send = vi.fn<WebSocket["send"]>();
  close = vi.fn<WebSocket["close"]>();
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    super();
    sockets.push(this);
  }
}

const sockets: FakeSocket[] = [];
const Socket: WebSocketConstructor = FakeSocket;

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("OAuth WebSocket factory", () => {
  it("builds the authentication socket URL from the control base", async () => {
    const auth = fakeAuth();
    const webSockets = new OAuthWebSocketFactory(
      auth,
      "https://control.example.edu",
      Socket,
    );
    const open = vi
      .spyOn(webSockets, "open")
      .mockResolvedValue(new FakeSocket("wss://unused", []));
    const client = new ControlClient(
      "https://control.example.edu/api/v1",
      auth,
      vi.fn<typeof globalThis.fetch>(),
      webSockets,
    );
    await client.sshAuthWebSocket("delta")();
    expect(open.mock.calls.map(([url]) => url)).toEqual([
      "wss://control.example.edu/api/v1/ssh/hosts/delta/auth",
    ]);
  });

  it("acquires fresh credentials and sends only the two exact subprotocols", async () => {
    const acquireToken = vi
      .fn()
      .mockResolvedValueOnce({ idToken: "token-✓" })
      .mockResolvedValueOnce({ idToken: "second-token" });
    const factory = new OAuthWebSocketFactory(
      { acquireToken },
      "https://control.example.edu",
      Socket,
    );
    window.localStorage.setItem("existing", "unchanged");
    window.sessionStorage.setItem("existing", "unchanged");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await factory.open("wss://control.example.edu/api/v1/ssh/hosts/delta/auth");
    await factory.open("wss://control.example.edu/api/v1/ssh/hosts/echo/auth");

    expect(acquireToken).toHaveBeenCalledTimes(2);
    expect(sockets.slice(-2).map(({ protocols }) => protocols)).toEqual([
      ["cybershuttle.v1", "bearer.dG9rZW4t4pyT"],
      ["cybershuttle.v1", "bearer.c2Vjb25kLXRva2Vu"],
    ]);
    expect(sockets.at(-2)?.url).toBe(
      "wss://control.example.edu/api/v1/ssh/hosts/delta/auth",
    );
    expect([
      window.localStorage.length,
      window.localStorage.getItem("existing"),
    ]).toEqual([1, "unchanged"]);
    expect([
      window.sessionStorage.length,
      window.sessionStorage.getItem("existing"),
    ]).toEqual([1, "unchanged"]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "contains space",
    "line\nbreak",
    "controlvalue",
    "x".repeat(16 * 1024 + 1),
  ])(
    "rejects a malformed or oversized ID token before opening a socket: %s",
    async (idToken) => {
      const before = sockets.length;
      const factory = new OAuthWebSocketFactory(
        { acquireToken: vi.fn(async () => ({ idToken })) },
        "https://control.example.edu",
        Socket,
      );
      await expect(
        factory.open("wss://control.example.edu/api/v1/ssh/hosts/delta/auth"),
      ).rejects.toThrow(/token/i);
      expect(sockets).toHaveLength(before);
    },
  );

  it("rejects token-bearing or unrelated URL forms before token acquisition", async () => {
    const { acquireToken } = fakeAuth();
    const factory = new OAuthWebSocketFactory(
      { acquireToken },
      "https://control.example.edu",
      Socket,
    );
    await expect(
      factory.open(
        "wss://control.example.edu/api/v1/ssh/hosts/delta/auth?token=x",
      ),
    ).rejects.toThrow("without credentials, query, or fragment");
    await expect(
      factory.open("wss://hostile.example/api/v1/ssh/hosts/delta/auth"),
    ).rejects.toThrow("outside the configured control origin");
    expect(acquireToken).not.toHaveBeenCalled();
  });
});
