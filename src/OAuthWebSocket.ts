import type { ITokenProvider } from "./ControlClient";
import { assertSecureOrLoopback } from "./Common";

export const CYBERSHUTTLE_WEBSOCKET_PROTOCOL = "cybershuttle.v1";
export const CYBERSHUTTLE_BEARER_PROTOCOL_PREFIX = "bearer.";
export const CYBERSHUTTLE_IDENTITY_PROTOCOL_PREFIX = "identity.";
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const TOKEN_CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f-\u009f]/u;

export type OAuthWebSocketConnector = () => Promise<WebSocket>;

export type WebSocketConstructor = new (
  url: string,
  protocols: string[],
) => WebSocket;

// Each call sends a freshly acquired bearer as a subprotocol.
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
    const encodedAccess = encodeAccessToken(credentials.accessToken);
    const encodedIdentity = encodeAccessToken(credentials.idToken);
    const socket = new this._WebSocket(url, [
      CYBERSHUTTLE_WEBSOCKET_PROTOCOL,
      `${CYBERSHUTTLE_BEARER_PROTOCOL_PREFIX}${encodedAccess}`,
      `${CYBERSHUTTLE_IDENTITY_PROTOCOL_PREFIX}${encodedIdentity}`,
    ]);
    return socket;
  }
}

export function encodeAccessToken(token: string): string {
  if (
    !token ||
    TOKEN_CONTROL_OR_WHITESPACE.test(token) ||
    token.trim() !== token
  ) {
    throw new Error(
      "CyberShuttle delegated token contains invalid characters.",
    );
  }
  const bytes = new TextEncoder().encode(token);
  if (bytes.byteLength > MAX_ACCESS_TOKEN_BYTES) {
    throw new Error("CyberShuttle delegated token is too large.");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function validateWebSocketUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CyberShuttle WebSocket URL is invalid.");
  }
  assertSecureOrLoopback(
    url,
    "wss:",
    "ws:",
    "CyberShuttle WebSocket URL must use WSS or loopback WS without credentials, query, or fragment.",
  );
  return url.toString();
}
