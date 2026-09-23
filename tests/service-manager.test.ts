// The service manager registry is fail-closed until a READY session is
// selected, keeping compute calls off the wrong session. It shares one
// ServerConnection.ISettings across contents, kernels, sessions and terminals.
// This workspace ships no local kernel and runs against a remote session's
// own Jupyter server; package.json's JupyterLab config must keep it that way.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PageConfig } from "@jupyterlab/coreutils";
import { PluginRegistry } from "@lumino/coreutils";
import { RemoteWorkspaces } from "../src/workspaces";
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
  KernelManager,
  KernelSpecManager,
  ServerConnection,
  SessionManager,
  TerminalManager,
} from "@jupyterlab/services";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import plugins, { remoteServicePlugins } from "../src/index";
import { ControlClient, IControlClient } from "../src/ControlClient";
import { jsonResponse } from "../src/Common";
import { getActiveSessionId } from "../src/session";
import { accessFixture } from "./fakes";

const id = "s-012345abcdef";

const supportManagers = {
  events: { dispose: vi.fn() },
  nbconvert: {},
  settings: {},
  user: {},
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
  ] as never);
  registry.registerPlugins(remoteServicePlugins as never);
  return registry;
}

afterEach(() => vi.unstubAllGlobals());

describe("shared cs-plane service", () => {
  it("provides one client to every plugin that reaches cs-plane", () => {
    const providers = plugins.filter(
      (plugin) => plugin.provides === IControlClient,
    );
    expect(providers).toHaveLength(1);
    expect(providers[0].activate(null as never)).toBeInstanceOf(ControlClient);

    for (const id of [
      "@cybershuttle/jupyter:remote-server-settings",
      "@cybershuttle/jupyter:session-ui",
      "@cybershuttle/jupyter:walltime-status",
    ]) {
      expect(plugins.find((plugin) => plugin.id === id)?.requires).toContain(
        IControlClient,
      );
    }
  });
});

describe("remote service manager registry", () => {
  it("constructs a fail-closed IServiceManager without session selection", async () => {
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
      "Select a READY CyberShuttle session",
    );
    await expect(
      manager.contents.save("example.txt", {
        type: "file",
        format: "text",
        content: "blocked",
      }),
    ).rejects.toThrow("Select a READY CyberShuttle session");
    expect(manager.events).toBe(supportManagers.events);
    expect(manager.nbconvert).toBe(supportManagers.nbconvert);
    expect(manager.settings).toBe(supportManagers.settings);
    expect(manager.user).toBe(supportManagers.user);
    expect(manager.workspaces).toBeInstanceOf(RemoteWorkspaces);
    await expect(manager.workspaces.fetch("s-1")).resolves.toEqual({
      data: {},
      metadata: { id: "s-1" },
    });
    manager.dispose();
  });

  it("does not trust cached session access without current authorization", async () => {
    window.sessionStorage.setItem(
      `cybershuttle.session-access.v1.${id}`,
      JSON.stringify(accessFixture(id, 1)),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    const registry = registryFor(
      `/lite/lab/index.html?session=${id}&workspace=${id}`,
    );

    const manager = await registry.resolveRequiredService(IServiceManager);
    await manager.ready;

    expect(getActiveSessionId()).toBeUndefined();
    expect(manager.contents.serverSettings.baseUrl).toBe(
      PageConfig.getBaseUrl(),
    );
    manager.dispose();
  });

  it("uses shared settings for contents, kernels, sessions, and terminals", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      let body: unknown = [];
      if (url.pathname.endsWith(`/sessions/${id}/access`)) {
        body = accessFixture(id, 1);
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
      return jsonResponse(body);
    });
    vi.stubGlobal("fetch", browserFetch);
    sessionStorage.setItem(
      "cybershuttle.oauth.v1",
      JSON.stringify({ idToken: "test", expiresAt: Date.now() + 60_000 }),
    );
    const registry = registryFor(
      `/lite/lab/index.html?session=${id}&workspace=${id}`,
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
    const remoteBase = "https://31002.use.devtunnels.ms/";
    expect(shellServerSettings.baseUrl).toBe(PageConfig.getBaseUrl());
    expect(manager.serverSettings).toBe(shellServerSettings);
    expect(contents.serverSettings.baseUrl).toBe(remoteBase);
    expect(kernels.serverSettings.baseUrl).toBe(remoteBase);
    expect(kernelspecs.serverSettings.baseUrl).toBe(remoteBase);
    assert.isDefined(sessions.serverSettings);
    expect(sessions.serverSettings.baseUrl).toBe(remoteBase);
    expect(terminals.serverSettings.baseUrl).toBe(remoteBase);
    expect(terminals.isAvailable()).toBe(true);

    await shellServerSettings.fetch(
      new URL("lab/api/settings", shellServerSettings.baseUrl).href,
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
        `/api/v1/sessions/${id}/access`,
        "/lab/api/settings",
        "/api/kernels",
        "/api/kernelspecs",
        "/api/sessions",
        "/api/terminals",
      ]),
    );

    manager.dispose();
    kernels.dispose();
    kernelspecs.dispose();
  });
});

describe("remote-only native workspace distribution", () => {
  const root = resolve(import.meta.dirname, "..");
  const liteConfig = JSON.parse(
    readFileSync(resolve(root, "jupyter-lite.json"), "utf8"),
  )["jupyter-config-data"];

  const requiredLiteSupportServices = [
    "@jupyterlite/services-extension:event-manager",
    "@jupyterlite/services-extension:nbconvert-manager",
    "@jupyterlite/services-extension:settings",
    "@jupyterlite/services-extension:user-manager",
  ];

  const disabledUpstreamServices = [
    "@jupyterlite/services-extension:workspace-manager",
    "@jupyterlab/services-extension:default-drive",
    "@jupyterlab/services-extension:contents-manager",
    "@jupyterlab/services-extension:kernel-manager",
    "@jupyterlab/services-extension:kernel-spec-manager",
    "@jupyterlab/services-extension:session-manager",
    "@jupyterlab/services-extension:service-manager",
    "@jupyterlite/services-extension:default-drive",
    "@jupyterlite/services-extension:kernel-client",
    "@jupyterlite/services-extension:kernel-manager",
    "@jupyterlite/services-extension:kernel-spec-client",
    "@jupyterlite/services-extension:kernel-spec-manager",
    "@jupyterlite/services-extension:kernel-specs",
    "@jupyterlite/services-extension:session-manager",
  ];

  it("keeps local shell settings while replacing compute services", () => {
    expect(liteConfig.disabledExtensions).toEqual(
      expect.arrayContaining(disabledUpstreamServices),
    );
    for (const support of requiredLiteSupportServices) {
      expect(liteConfig.disabledExtensions).not.toContain(support);
    }
  });
});
