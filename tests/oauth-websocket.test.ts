import { fakeAuth } from "./fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../src/ControlClient";
import {
  OAuthWebSocketFactory,
  type WebSocketConstructor,
} from "../src/OAuthWebSocket";

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
      "wss://control.example.edu/api/v1/ssh/delta/auth",
    ]);
  });

  it("acquires fresh credentials and sends only the three exact subprotocols", async () => {
    // The multibyte token is the point: the subprotocol carries base64url of the
    // UTF-8 bytes, so an ASCII-only vector would not exercise the encoding.
    const acquireToken = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "token-✓", idToken: "first-id" })
      .mockResolvedValueOnce({
        accessToken: "second-token",
        idToken: "second-id",
      });
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

    await factory.open("wss://control.example.edu/api/v1/ssh/delta/auth");
    await factory.open("wss://control.example.edu/api/v1/ssh/delta/terminal");

    expect(acquireToken).toHaveBeenCalledTimes(2);
    expect(sockets.slice(-2).map(({ protocols }) => protocols)).toEqual([
      ["cybershuttle.v1", "bearer.dG9rZW4t4pyT", "identity.Zmlyc3QtaWQ"],
      ["cybershuttle.v1", "bearer.c2Vjb25kLXRva2Vu", "identity.c2Vjb25kLWlk"],
    ]);
    expect(sockets.at(-2)?.url).toBe(
      "wss://control.example.edu/api/v1/ssh/delta/auth",
    );
    expect(sockets.at(-2)?.url).not.toContain("token");
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

  // Both bearers must be validated, so the table varies the field as well as the value.
  it.each([
    ["accessToken", ""],
    ["accessToken", "contains space"],
    ["accessToken", "line\nbreak"],
    ["accessToken", "control\u007fvalue"],
    ["accessToken", "x".repeat(16 * 1024 + 1)],
    ["idToken", "identity with space"],
    ["idToken", "x".repeat(16 * 1024 + 1)],
  ] as const)(
    "rejects a malformed or oversized %s before opening a socket",
    async (field, token) => {
      const before = sockets.length;
      const factory = new OAuthWebSocketFactory(
        {
          acquireToken: vi.fn(async () => ({
            accessToken: "valid-access",
            idToken: "identity-token",
            [field]: token,
          })),
        },
        "https://control.example.edu",
        Socket,
      );
      await expect(
        factory.open("wss://control.example.edu/api/v1/ssh/delta/auth"),
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
      factory.open("wss://control.example.edu/api/v1/ssh/delta/auth?token=x"),
    ).rejects.toThrow("without credentials, query, or fragment");
    await expect(
      factory.open("wss://hostile.example/api/v1/ssh/delta/auth"),
    ).rejects.toThrow("outside the configured control origin");
    expect(acquireToken).not.toHaveBeenCalled();
  });
});
