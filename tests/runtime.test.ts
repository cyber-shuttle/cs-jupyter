import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  createRuntimeServerSettings,
  validControlApiUrl,
  validRuntimeId,
} from "../src/ControlClient";
import {
  installRuntimeCommandGuard,
  RuntimeController,
} from "../src/RuntimeController";
import type { IRuntime } from "../src/Common";
import { cacheRuntimeAccess, type IRuntimeAccess } from "../src/runtime-access";
import { fakeAuth, runtimeFixture } from "./fakes";

const auth = fakeAuth("test-delegated-token");

const runtimeRequest = {
  idempotencyKey: "idem",
  sshHost: "delta",
  partition: "debug",
  rootFolder: "projects/demo",
  resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
};

const access: IRuntimeAccess = {
  runtimeId: "rt-012345abcdef",
  generation: "g-0123456789abcdef",
  expiresAt: "2030-01-01T00:00:00Z",
  jupyter: {
    uri: "https://31002.use.devtunnels.ms/",
    token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
};

const runtime = runtimeFixture({
  account: "project-a",
  resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
});

beforeEach(() => {
  window.history.replaceState({}, "", "/gateway/lab");
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("shared cs-control client", () => {
  it("uses one exact API for SSH and runtime operations", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/gateway/api/v1/ssh") {
          return response({ hosts: [] });
        }
        if (path.endsWith("/slurm")) {
          return response({
            host: "delta",
            homeDir: "/home/a",
            accounts: [],
            partitions: [],
          });
        }
        if (path === "/gateway/api/v1/runtimes/validate") {
          return response({
            runtimeId: "rt-012345abcdef",
            status: "PASSED",
            script: "#!/bin/bash\n#SBATCH --partition=debug\n",
            message: "Validated.",
            stdout: "validation output",
            stderr: "",
          });
        }
        if (path === "/gateway/api/v1/runtimes" && request.method === "GET") {
          return response({ runtimes: [runtime], logs: [] });
        }
        if (path.endsWith("/access")) return response(access);
        return response(runtime);
      },
    );
    const client = new ControlClient(
      "http://localhost:3000/gateway/api/v1",
      auth,
      fetch as any,
    );
    await client.listSshHosts();
    await client.listRuntimes();
    const request = {
      idempotencyKey: "idem",
      sshHost: "delta",
      partition: "debug",
      rootFolder: "projects/demo",
      resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
    };
    await client.validateRuntime(request);
    await client.createRuntime({
      idempotencyKey: "idem",
      sshHost: "delta",
      partition: "debug",
      rootFolder: "projects/demo",
      resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
    });
    await client.getRuntime(runtime.id);
    expect(await client.getRuntimeAccess(runtime.id)).toEqual(access);
    await client.stopRuntime(runtime.id);
    const requests = fetch.mock.calls.map(
      ([input, init]) => new Request(input, init),
    );
    expect(
      requests.map((item) => `${item.method} ${new URL(item.url).pathname}`),
    ).toEqual([
      "GET /gateway/api/v1/ssh",
      "GET /gateway/api/v1/runtimes",
      "POST /gateway/api/v1/runtimes/validate",
      "POST /gateway/api/v1/runtimes",
      "GET /gateway/api/v1/runtimes/rt-012345abcdef",
      "GET /gateway/api/v1/runtimes/rt-012345abcdef/access",
      "POST /gateway/api/v1/runtimes/rt-012345abcdef/stop",
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

  it("clears runtime access only after a successful Stop API", async () => {
    const client = new ControlClient(
      "http://localhost:3000/gateway/api/v1",
      auth,
      vi.fn(async () => response(runtime)) as any,
    );
    const key = `cybershuttle.runtime-access.v1.${runtime.id}`;

    cacheRuntimeAccess(access);
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    await client.stopRuntime(runtime.id);
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it("retains runtime access when the Stop API fails", async () => {
    const client = new ControlClient(
      "http://localhost:3000/gateway/api/v1",
      auth,
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "request_failed", message: "failed" },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ) as any,
    );
    const key = `cybershuttle.runtime-access.v1.${runtime.id}`;

    cacheRuntimeAccess(access);
    await expect(client.stopRuntime(runtime.id)).rejects.toThrow("failed");
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
  });

  it("strictly validates the stopped runtime identity and response", async () => {
    for (const value of [
      { ...runtime, id: "rt-111111111111" },
      { ...runtime, state: "UNKNOWN" },
    ]) {
      const client = new ControlClient(
        "http://localhost:3000/gateway/api/v1",
        auth,
        vi.fn(async () => response(value)) as any,
      );
      await expect(client.stopRuntime(runtime.id)).rejects.toThrow(
        /invalid .*runtime/,
      );
    }
  });

  it("strictly validates runtime validation responses", async () => {
    for (const value of [
      { status: "UNKNOWN", script: "x", message: "x" },
      { status: "PASSED", script: "x", message: "x", extra: true },
    ]) {
      const client = new ControlClient(
        "http://localhost:3000/gateway/api/v1",
        auth,
        vi.fn(async () => response(value)) as any,
      );
      await expect(
        client.validateRuntime({
          idempotencyKey: "idem",
          sshHost: "delta",
          partition: "debug",
          rootFolder: ".",
          resources: { cores: 1, memoryMb: 1024, wallMinutes: 30 },
        }),
      ).rejects.toThrow("invalid runtime validation");
    }
  });

  it("rejects fields outside the allocation contract", async () => {
    for (const value of [
      { ...runtime, jobId: 4 },
      { ...runtime, node: [] },
    ]) {
      const client = new ControlClient(
        "http://localhost:3000/gateway/api/v1",
        auth,
        vi.fn(async () => response({ runtimes: [value], logs: [] })) as any,
      );
      await expect(client.listRuntimes()).rejects.toThrow("invalid runtime");
    }
  });

  it("requires an explicitly configured control API", () => {
    expect(() => validControlApiUrl("")).toThrow("cybershuttleControlApiUrl");
  });

  it("rejects unsafe control API URLs and malformed runtime ids", () => {
    expect(validControlApiUrl("http://localhost:3000/gateway/api/v1")).toBe(
      "http://localhost:3000/gateway/api/v1",
    );
    expect(() => validControlApiUrl("/gateway/api/v1")).toThrow(
      "absolute control API URL",
    );
    expect(validRuntimeId(runtime.id)).toBe(runtime.id);
    expect(validControlApiUrl("https://other.example/api/v1")).toBe(
      "https://other.example/api/v1",
    );
    expect(() => validRuntimeId("not-a-runtime")).toThrow();
  });

  it("constructs capability-authorized Jupyter HTTP and WebSocket settings", async () => {
    const fetch = vi.fn(async () => response({}));
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      readonly url: string;
      readonly protocols: string[];
      protocol = "";
      close = vi.fn();
      constructor(url: string | URL, protocols: string[] = []) {
        super();
        this.url = String(url);
        this.protocols = protocols;
        sockets.push(this);
      }
    }
    const settings = createRuntimeServerSettings(access, {
      fetch: fetch as any,
    });
    expect(settings.baseUrl).toBe("https://31002.use.devtunnels.ms/");
    expect(settings.wsUrl).toBe("wss://31002.use.devtunnels.ms/");
    // ServerConnection sends the token as an Authorization header on REST and appends it to
    // WebSocket URLs, so nothing here has to reimplement either.
    expect(settings.token).toBe(access.jupyter.token);
    expect(settings.appendToken).toBe(true);
  });

  it.each([401, 403])(
    "invalidates cached application access after Jupyter HTTP %i",
    async (status) => {
      cacheRuntimeAccess(access);
      const settings = createRuntimeServerSettings(access, {
        fetch: vi.fn(async () => new Response(null, { status })) as any,
      });
      await settings.fetch(new URL("api/status", settings.baseUrl));
      expect(window.sessionStorage.length).toBe(0);
    },
  );
});

describe("runtime command guard", () => {
  it("opens the chooser for notebooks, consoles, and terminals until selected", async () => {
    const execute = vi.fn(async () => undefined);
    const app = {
      commands: { execute, hasCommand: vi.fn(() => true) },
      shell: { currentWidget: null },
    };
    const controller = new RuntimeController(
      app as any,
      {} as any,
      vi.fn(),
      vi.fn(),
    );
    installRuntimeCommandGuard(app as any, controller, "choose");
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
    const settings = createRuntimeServerSettings(access, {
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
