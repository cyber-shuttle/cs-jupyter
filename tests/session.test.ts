// The shared ControlClient used for session lifecycle calls and for building
// Jupyter server connection settings. Validating a session id before an action
// avoids reporting a spurious failure for an already-stopped session.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  createSessionServerSettings,
} from "../src/ControlClient";
import {
  jsonResponse as response,
  validControlApiUrl,
  validSessionId,
} from "../src/Common";
import {
  installSessionCommandGuard,
  SessionController,
} from "../src/SessionController";
import {
  cacheSessionAccess,
  selectedSession,
  sessionLiteUrl,
} from "../src/session";
import {
  accessFixture,
  fakeAuth,
  fakeCommandApp,
  sessionFixture,
} from "./fakes";

const auth = fakeAuth("test-delegated-token");

const access = accessFixture("s-012345abcdef", 1);

const session = sessionFixture({
  account: "project-a",
  resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
});

beforeEach(() => {
  window.history.replaceState({}, "", "/gateway/lab");
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("shared cs-control client", () => {
  function makeClient(browserFetch: typeof globalThis.fetch) {
    return new ControlClient(
      "http://localhost:3000/gateway/api/v1",
      auth,
      browserFetch,
    );
  }

  it("uses one exact API for SSH and session operations", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/gateway/api/v1/ssh") {
          return response({ hosts: [] });
        }
        if (path === "/gateway/api/v1/sessions/validate") {
          return response({
            sessionId: "s-012345abcdef",
            status: "PASSED",
            script: "#!/bin/bash\n#SBATCH --partition=debug\n",
            message: "Validated.",
            stderr: "",
          });
        }
        if (path === "/gateway/api/v1/sessions" && request.method === "GET") {
          return response({ sessions: [session], logs: [] });
        }
        if (path.endsWith("/access")) return response(access);
        return response(session);
      },
    );
    const client = makeClient(fetch as any);
    await client.listSshHosts();
    await client.listSessions();
    const request = {
      idempotencyKey: "idem",
      sshHost: "delta",
      partition: "debug",
      rootFolder: "projects/demo",
      resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
    };
    await client.validateCreateRequest(request);
    await client.createSession(request);
    await client.getSession(session.id);
    expect(await client.getSessionAccess(session.id)).toEqual(access);
    await client.stopSession(session.id);
    const requests = fetch.mock.calls.map(
      ([input, init]) => new Request(input, init),
    );
    expect(
      requests.map((item) => `${item.method} ${new URL(item.url).pathname}`),
    ).toEqual([
      "GET /gateway/api/v1/ssh",
      "GET /gateway/api/v1/sessions",
      "POST /gateway/api/v1/sessions/validate",
      "POST /gateway/api/v1/sessions",
      "GET /gateway/api/v1/sessions/s-012345abcdef",
      "GET /gateway/api/v1/sessions/s-012345abcdef/access",
      "POST /gateway/api/v1/sessions/s-012345abcdef/stop",
    ]);
    expect(
      requests.every(
        (item) =>
          item.headers.get("Authorization") === "Bearer test-delegated-token",
      ),
    ).toBe(true);
    expect(requests.every((item) => !item.headers.has("X-XSRFToken"))).toBe(
      true,
    );
  });

  it("rejects a getSession answer for another session", async () => {
    const client = makeClient(
      vi.fn(async () => response({ ...session, id: "s-999999999999" })) as any,
    );
    await expect(client.getSession(session.id)).rejects.toThrow(
      "cs-control returned a different session.",
    );
  });

  it("clears session access only after a successful Stop API", async () => {
    const client = makeClient(vi.fn(async () => response(session)) as any);
    const key = `cybershuttle.session-access.v1.${session.id}`;

    cacheSessionAccess(access);
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    await client.stopSession(session.id);
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it("retains session access when the Stop API fails", async () => {
    const client = makeClient(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "request_failed", message: "failed" },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          ),
      ) as any,
    );
    const key = `cybershuttle.session-access.v1.${session.id}`;

    cacheSessionAccess(access);
    await expect(client.stopSession(session.id)).rejects.toThrow("failed");
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
  });

  it("rejects a malformed id before the action is sent, not after", async () => {
    const fetch = vi.fn(async () => response({ ...session, id: "s-invalid!" }));
    const client = makeClient(fetch as any);
    await expect(client.stopSession("s-invalid!")).rejects.toThrow(
      "Invalid session id.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before requesting session access, not after", async () => {
    const fetch = vi.fn(async () => response(access));
    const client = makeClient(fetch as any);
    await expect(client.getSessionAccess("s-invalid!")).rejects.toThrow(
      "Invalid session id.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strictly validates the stopped session identity and response", async () => {
    for (const value of [
      { ...session, id: "s-111111111111" },
      { ...session, state: "UNKNOWN" },
    ]) {
      const client = makeClient(vi.fn(async () => response(value)) as any);
      await expect(client.stopSession(session.id)).rejects.toThrow(
        /invalid .*session/,
      );
    }
  });

  it("strictly validates session validation responses", async () => {
    for (const value of [
      {
        sessionId: "s-012345abcdef",
        status: "UNKNOWN",
        script: "x",
        message: "x",
      },
      {
        sessionId: "s-012345abcdef",
        status: "PASSED",
        script: "x",
        message: "x",
        extra: true,
      },
    ]) {
      const client = makeClient(vi.fn(async () => response(value)) as any);
      await expect(
        client.validateCreateRequest({
          idempotencyKey: "idem",
          sshHost: "delta",
          partition: "debug",
          rootFolder: ".",
          resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
        }),
      ).rejects.toThrow("invalid session validation");
    }
  });

  it("accepts plain http on every loopback host a URL reports, and nowhere else", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = `http://${host}:8045/api/v1`;
      expect(validControlApiUrl(url)).toBe(url);
    }
    expect(() => validControlApiUrl("http://other.example/api/v1")).toThrow(
      "HTTPS or loopback HTTP",
    );
    expect(() => validControlApiUrl("/gateway/api/v1")).toThrow(
      "absolute control API URL",
    );
    expect(validSessionId(session.id)).toBe(session.id);
    expect(() => validSessionId("not-a-session")).toThrow();
  });

  it("constructs token-authorized Jupyter HTTP and WebSocket settings", async () => {
    const settings = createSessionServerSettings(access);
    expect(settings.baseUrl).toBe("https://31002.use.devtunnels.ms/");
    expect(settings.wsUrl).toBe("wss://31002.use.devtunnels.ms/");
    expect(settings.token).toBe(access.jupyter.token);
    expect(settings.appendToken).toBe(true);
  });

  it.each([401, 403])(
    "invalidates cached application access after Jupyter HTTP %i",
    async (status) => {
      cacheSessionAccess(access);
      const settings = createSessionServerSettings(access, {
        fetch: vi.fn(async () => new Response(null, { status })) as any,
      });
      await settings.fetch(new URL("api/status", settings.baseUrl).href);
      expect(window.sessionStorage.length).toBe(0);
    },
  );
});

describe("session command guard", () => {
  it("opens the chooser for notebooks, consoles, and terminals until selected", async () => {
    const { execute, app } = fakeCommandApp();
    const controller = new SessionController(
      app as any,
      {} as any,
      vi.fn(),
      vi.fn(),
    );
    installSessionCommandGuard(app as any, controller, "choose");
    await app.commands.execute("notebook:create-new");
    await app.commands.execute("console:create");
    await app.commands.execute("terminal:create-new");
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "choose",
      "choose",
      "choose",
    ]);
  });
});

describe("kernel spec logos", () => {
  it("drops resources an <img> could never fetch instead of rendering a broken icon", async () => {
    const body = {
      kernelspecs: {
        python3: {
          name: "python3",
          resources: {
            "logo-svg": "/kernelspecs/python3/logo-svg.svg",
            "logo-64x64": "/kernelspecs/python3/logo-64x64.png",
          },
        },
      },
    };
    const settings = createSessionServerSettings(access, {
      fetch: (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const response = await settings.fetch(
      "https://31002.use.devtunnels.ms/api/kernelspecs",
    );
    const parsed = await response.json();
    expect(parsed.kernelspecs.python3.resources).toEqual({});
    expect(parsed.kernelspecs.python3.name).toBe("python3");
  });
});

describe("native Lite session routing", () => {
  const id = "s-012345abcdef";
  const seq = 1;

  it("selects on a valid session id alone", () => {
    expect(selectedSession("?session=not-a-session")).toBeUndefined();
    expect(selectedSession(`?session=${id}`)).toEqual({ sessionId: id });
    expect(selectedSession(`?session=${id}&seq=${seq}`)).toEqual({
      sessionId: id,
    });
  });

  it("keeps session selection within the current Lite application URL", () => {
    expect(
      sessionLiteUrl(id, "folder/example.ipynb", {
        href: "http://localhost/lite/lab/index.html?old=value&seq=1",
      }),
    ).toBe(
      "http://localhost/lite/lab/index.html?old=value&session=s-012345abcdef&workspace=s-012345abcdef&path=folder%2Fexample.ipynb",
    );
  });
});
