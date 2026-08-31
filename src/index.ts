import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { PageConfig } from "@jupyterlab/coreutils";
import type {
  Contents,
  Kernel,
  KernelSpec,
  ServiceManager as ServiceManagerType,
  ServiceManagerPlugin,
  Session,
} from "@jupyterlab/services";
import {
  ContentsManager,
  Drive,
  IContentsManager,
  IDefaultDrive,
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
  ServiceManager,
  SessionManager,
  TerminalManager,
} from "@jupyterlab/services";
import { Token } from "@lumino/coreutils";
import { ControlClient, createRuntimeServerSettings } from "./ControlClient.js";
import { cacheRuntimeAccess, loadRuntimeAccess } from "./runtime-access.js";

import { getActiveRuntimeId, setActiveRuntimeId } from "./runtime-state.js";
import { runtimeUiPlugin, selectedRuntime } from "./runtime-ui.js";

export const IRemoteServerSettings = new Token<ServerConnection.ISettings>(
  "@cybershuttle/jupyter:IRemoteServerSettings",
  "Server settings for the selected READY CyberShuttle runtime.",
);

function failClosedServerSettings(): ServerConnection.ISettings {
  const baseUrl = new URL(PageConfig.getBaseUrl(), window.location.origin);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      baseUrl,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const relative = url.pathname
      .slice(baseUrl.pathname.length)
      .replace(/\/+$/, "");
    if (method === "GET") {
      if (relative === "api/contents") {
        return jsonResponse({
          name: "",
          path: "",
          type: "directory",
          writable: false,
          created: "1970-01-01T00:00:00.000Z",
          last_modified: "1970-01-01T00:00:00.000Z",
          mimetype: null,
          content: [],
          format: "json",
        });
      }
      if (["api/kernels", "api/sessions", "api/terminals"].includes(relative)) {
        return jsonResponse([]);
      }
      if (relative === "api/kernelspecs") {
        return jsonResponse({ default: "", kernelspecs: {} });
      }
    }
    return jsonResponse(
      { message: "Select a READY CyberShuttle runtime first." },
      503,
    );
  };
  const settings = ServerConnection.makeSettings({
    appendToken: false,
    baseUrl: baseUrl.toString(),
    fetch,
    token: "",
    wsUrl: baseUrl.toString().replace(/^http/, "ws"),
  });
  return settings;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const remoteServerSettingsPlugin: ServiceManagerPlugin<
  ServiceManagerType.IManager["serverSettings"]
> = {
  id: "@cybershuttle/jupyter:remote-server-settings",
  description:
    "Provide a READY cs-control runtime or the fail-closed controller bootstrap to compute managers.",
  autoStart: true,
  provides: IRemoteServerSettings,
  activate: async () => {
    const controlApiUrl = PageConfig.getOption("cybershuttleControlApiUrl");
    try {
      const selected = selectedRuntime();
      if (!selected) {
        throw new Error("No runtime selected.");
      }
      const { runtimeId, generation } = selected;
      // A READY runtime is a running Jupyter Server: cs-control only issues access once the
      // allocation is up, so its response is the readiness signal.
      let access = loadRuntimeAccess(runtimeId, generation);
      if (!access) {
        access = await new ControlClient(controlApiUrl).getRuntimeAccess(
          runtimeId,
        );
        if (access.generation !== generation)
          throw new Error("Selected runtime access generation changed.");
        cacheRuntimeAccess(access);
      }
      PageConfig.setOption("terminalsAvailable", "true");
      setActiveRuntimeId(runtimeId);
      return createRuntimeServerSettings(access);
    } catch {
      PageConfig.setOption("terminalsAvailable", "false");
      setActiveRuntimeId(undefined);
      return failClosedServerSettings();
    }
  },
};

const defaultDrivePlugin: ServiceManagerPlugin<Contents.IDrive> = {
  id: "@cybershuttle/jupyter:default-drive",
  description: "Use the selected runtime's Jupyter Contents REST API.",
  autoStart: true,
  provides: IDefaultDrive,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new Drive({ serverSettings }),
};

const contentsManagerPlugin: ServiceManagerPlugin<Contents.IManager> = {
  id: "@cybershuttle/jupyter:contents-manager",
  description: "Use the selected runtime's Jupyter Contents REST API manager.",
  autoStart: true,
  provides: IContentsManager,
  requires: [IDefaultDrive, IRemoteServerSettings],
  activate: (_app, defaultDrive, serverSettings) =>
    new ContentsManager({ defaultDrive, serverSettings }),
};

const kernelManagerPlugin: ServiceManagerPlugin<Kernel.IManager> = {
  id: "@cybershuttle/jupyter:kernel-manager",
  description: "Use the selected runtime's Kernels REST and WebSocket APIs.",
  autoStart: true,
  provides: IKernelManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new KernelManager({ serverSettings }),
};

const kernelSpecManagerPlugin: ServiceManagerPlugin<KernelSpec.IManager> = {
  id: "@cybershuttle/jupyter:kernel-spec-manager",
  description: "Populate kernel specifications from the selected runtime.",
  autoStart: true,
  provides: IKernelSpecManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new KernelSpecManager({ serverSettings }),
};

const sessionManagerPlugin: ServiceManagerPlugin<Session.IManager> = {
  id: "@cybershuttle/jupyter:session-manager",
  description: "Use the selected runtime's Jupyter Sessions REST API.",
  autoStart: true,
  provides: ISessionManager,
  requires: [IKernelManager, IRemoteServerSettings],
  activate: (_app, kernelManager, serverSettings) =>
    new SessionManager({ kernelManager, serverSettings }),
};

const terminalManagerPlugin: ServiceManagerPlugin<
  ServiceManagerType.IManager["terminals"]
> = {
  id: "@cybershuttle/jupyter:terminal-manager",
  description: "Use terminals only on a selected READY remote runtime.",
  autoStart: true,
  provides: ITerminalManager,
  requires: [IRemoteServerSettings],
  // ponytail: the active runtime id is the fail-closed signal; tag the settings
  // object only if a second settings producer ever appears.
  activate: (_app, serverSettings) =>
    getActiveRuntimeId()
      ? new TerminalManager({ serverSettings })
      : new TerminalManager.NoopManager({ serverSettings }),
};

const remoteTerminalUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:remote-terminal-ui",
  description: "Activate JupyterLab terminals only for a READY remote runtime.",
  autoStart: true,
  requires: [IServiceManager],
  activate: async (app, services) => {
    if (services.terminals.isAvailable()) {
      await app.activatePlugin("@jupyterlab/terminal-extension:plugin");
    }
  },
};

const serviceManagerPlugin: ServiceManagerPlugin<ServiceManagerType.IManager> =
  {
    id: "@cybershuttle/jupyter:service-manager",
    description:
      "Compose remote managers or fail-closed controller-only managers.",
    autoStart: true,
    provides: IServiceManager,
    requires: [
      IServerSettings,
      IRemoteServerSettings,
      IContentsManager,
      IKernelManager,
      IKernelSpecManager,
      ISessionManager,
      ITerminalManager,
      IEventManager,
      INbConvertManager,
      ISettingManager,
      IUserManager,
      IWorkspaceManager,
    ],
    activate: (
      _app,
      shellServerSettings,
      _remoteServerSettings,
      contents,
      kernels,
      kernelspecs,
      sessions,
      terminals,
      events,
      nbconvert,
      settings,
      user,
      workspaces,
    ) =>
      new ServiceManager({
        contents,
        events,
        kernels,
        kernelspecs,
        nbconvert,
        serverSettings: shellServerSettings,
        sessions,
        settings,
        terminals,
        user,
        workspaces,
        standby: getActiveRuntimeId() ? "when-hidden" : () => true,
      }),
  };

export { runtimeLiteUrl, SELECT_RUNTIME_COMMAND } from "./runtime-ui.js";

export const remoteServicePlugins = [
  remoteServerSettingsPlugin,
  defaultDrivePlugin,
  contentsManagerPlugin,
  kernelManagerPlugin,
  kernelSpecManagerPlugin,
  sessionManagerPlugin,
  terminalManagerPlugin,
  serviceManagerPlugin,
];

export default [
  ...remoteServicePlugins,
  remoteTerminalUiPlugin,
  runtimeUiPlugin,
];
