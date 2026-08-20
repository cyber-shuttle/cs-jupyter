import { PageConfig } from "@jupyterlab/coreutils";
import { PluginRegistry } from "@lumino/coreutils";
import {
  ContentsManager,
  IContentsManager,
  IEventManager,
  IKernelManager,
  IKernelSpecManager,
  INbConvertManager,
  IServerSettings,
  IServiceManager,
  ISessionManager,
  ISettingManager,
  ITerminalManager,
  IUserManager,
  IWorkspaceManager,
  KernelManager,
  KernelSpecManager,
  ServerConnection,
  SessionManager,
  TerminalManager,
} from "@jupyterlab/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import { remoteServicePlugins } from "../src/index.js";
import { getActiveRuntimeId } from "../src/runtime-state.js";

const id = "rt-012345abcdef";
const runtime = (state = "READY") => ({
  id,
  generation: "g-0123456789abcdef",
  state,
  sshHost: "delta",
  account: "project-a",
  partition: "debug",
  rootFolder: "projects/demo",
  resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
});

const supportManagers = {
  events: { dispose: vi.fn() },
  nbconvert: {},
  settings: {},
  user: {},
  workspaces: {},
};

function registryFor(path: string): PluginRegistry<null> {
  window.history.replaceState({}, "", path);
  PageConfig.setOption(
    "cybershuttleControlApiUrl",
    "http://localhost:3000/api/v1",
  );
  const registry = new PluginRegistry<null>();
  registry.registerPlugins([
    {
      id: "test:lite-server-settings",
      autoStart: true,
      provides: IServerSettings,
      activate: () => ServerConnection.makeSettings(),
    },
    {
      id: "test:event-manager",
      autoStart: true,
      provides: IEventManager,
      activate: () => supportManagers.events,
    },
    {
      id: "test:nbconvert-manager",
      autoStart: true,
      provides: INbConvertManager,
      activate: () => supportManagers.nbconvert,
    },
    {
      id: "test:setting-manager",
      autoStart: true,
      provides: ISettingManager,
      activate: () => supportManagers.settings,
    },
    {
      id: "test:user-manager",
      autoStart: true,
      provides: IUserManager,
      activate: () => supportManagers.user,
    },
    {
      id: "test:workspace-manager",
      autoStart: true,
      provides: IWorkspaceManager,
      activate: () => supportManagers.workspaces,
    },
  ] as never);
  registry.registerPlugins(remoteServicePlugins);
  return registry;
}

afterEach(() => vi.unstubAllGlobals());

describe("remote service manager registry", () => {
  it("constructs a fail-closed IServiceManager without runtime selection", async () => {
    const registry = registryFor("/lite/lab/index.html");
    const manager = await registry.resolveRequiredService(IServiceManager);
    await manager.ready;
    expect(manager.serverSettings.baseUrl).toBe(PageConfig.getBaseUrl());
    expect([...manager.kernels.running()]).toEqual([]);
    expect(manager.terminals).toBeInstanceOf(TerminalManager.NoopManager);
    await expect(manager.contents.get("")).resolves.toMatchObject({
      path: "",
      type: "directory",
      writable: false,
      content: [],
    });
    await expect(manager.contents.get("example.ipynb")).rejects.toThrow(
      "Select a READY CyberShuttle runtime",
    );
    await expect(
      manager.contents.save("example.txt", {
        type: "file",
        format: "text",
        content: "blocked",
      }),
    ).rejects.toThrow("Select a READY CyberShuttle runtime");
    expect(manager.events).toBe(supportManagers.events);
    expect(manager.nbconvert).toBe(supportManagers.nbconvert);
    expect(manager.settings).toBe(supportManagers.settings);
    expect(manager.user).toBe(supportManagers.user);
    expect(manager.workspaces).toBe(supportManagers.workspaces);
    manager.dispose();
  });

  it("uses fail-closed services for a non-READY runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(runtime("STARTING")), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const registry = registryFor(
      `/lite/lab/index.html?runtime=${id}&generation=g-0123456789abcdef`,
    );
    const manager = await registry.resolveRequiredService(IServiceManager);
    await manager.ready;
    expect(manager.serverSettings.baseUrl).toBe(PageConfig.getBaseUrl());
    expect(getActiveRuntimeId()).toBeUndefined();
    manager.dispose();
  });

  it("uses shared settings for contents, kernels, sessions, and terminals", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      let body: unknown = [];
      if (url.pathname.endsWith(`/runtimes/${id}`)) {
        body = runtime();
      } else if (url.pathname.endsWith("/api/kernelspecs")) {
        body = {
          default: "python",
          kernelspecs: {
            python: {
              name: "python",
              resources: {},
              spec: {
                argv: ["python"],
                display_name: "Remote Python",
                language: "python",
              },
            },
          },
        };
      }
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", browserFetch);
    window.sessionStorage.setItem(
      `cybershuttle.runtime-access.v1.${id}`,
      JSON.stringify({
        runtimeId: id,
        generation: "g-0123456789abcdef",
        expiresAt: "2030-01-01T00:00:00Z",
        jupyter: {
          uri: "https://31002.use.devtunnels.ms/",
          token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      }),
    );
    const registry = registryFor(
      `/lite/lab/index.html?runtime=${id}&generation=g-0123456789abcdef`,
    );

    const manager = await registry.resolveRequiredService(IServiceManager);
    const contents = await registry.resolveRequiredService(IContentsManager);
    const kernels = await registry.resolveRequiredService(IKernelManager);
    const kernelspecs =
      await registry.resolveRequiredService(IKernelSpecManager);
    const shellServerSettings =
      await registry.resolveRequiredService(IServerSettings);
    const sessions = await registry.resolveRequiredService(ISessionManager);
    const terminals = await registry.resolveRequiredService(ITerminalManager);

    expect(manager.contents).toBe(contents);
    expect(manager.kernels).toBe(kernels);
    expect(manager.kernelspecs).toBe(kernelspecs);
    expect(manager.sessions).toBe(sessions);
    expect(manager.terminals).toBe(terminals);
    expect(contents).toBeInstanceOf(ContentsManager);
    expect(kernels).toBeInstanceOf(KernelManager);
    expect(kernelspecs).toBeInstanceOf(KernelSpecManager);
    expect(sessions).toBeInstanceOf(SessionManager);
    expect(terminals).toBeInstanceOf(TerminalManager);
    const remoteBase = "https://31002.use.devtunnels.ms/";
    expect(shellServerSettings.baseUrl).toBe(PageConfig.getBaseUrl());
    expect(manager.serverSettings).toBe(shellServerSettings);
    expect(contents.serverSettings.baseUrl).toBe(remoteBase);
    expect(kernels.serverSettings.baseUrl).toBe(remoteBase);
    expect(kernelspecs.serverSettings.baseUrl).toBe(remoteBase);
    expect(sessions.serverSettings.baseUrl).toBe(remoteBase);
    expect(terminals.serverSettings.baseUrl).toBe(remoteBase);
    expect(terminals.isAvailable()).toBe(true);

    await shellServerSettings.fetch(
      new URL("lab/api/settings", shellServerSettings.baseUrl),
    );
    await Promise.all([
      kernels.ready,
      kernelspecs.ready,
      sessions.ready,
      terminals.ready,
    ]);
    const paths = browserFetch.mock.calls.map(
      ([input]) =>
        new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        ).pathname,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "/lab/api/settings",
        "/api/kernels",
        "/api/kernelspecs",
        "/api/sessions",
        "/api/terminals",
      ]),
    );
    expect(
      paths.some(
        (path) =>
          path.includes(`/runtimes/${id}/jupyter/`) &&
          path.includes("lab/api/settings"),
      ),
    ).toBe(false);

    manager.dispose();
    kernels.dispose();
    kernelspecs.dispose();
  });
});
