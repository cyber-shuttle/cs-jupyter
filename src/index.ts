// The extension's entry point: JupyterLab service-manager plugins that point
// every service at the active session's server. It fails closed rather than
// falling back to an unauthenticated default server. cs-control issues access
// only once a session is up, so a response from it is the readiness signal.
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { PageConfig } from "@jupyterlab/coreutils";
import type {
  Contents,
  Kernel,
  KernelSpec,
  ServiceManager as ServiceManagerType,
  ServiceManagerPlugin,
  Session,
  Workspace,
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
import { ControlClient, createSessionServerSettings } from "./ControlClient.js";
import { jsonResponse, requestUrl } from "./Common.js";
import {
  cacheSessionAccess,
  clearAllSessionAccess,
  getActiveSessionId,
  selectedSession,
  sessionHomeUrl,
  setActiveSessionId,
} from "./session.js";
import { sessionUiPlugin } from "./session-ui.js";
import { RemoteWorkspaces } from "./workspaces.js";
import { walltimeStatusPlugin } from "./metrics.js";

const IRemoteServerSettings = new Token<ServerConnection.ISettings>(
  "@cybershuttle/jupyter:IRemoteServerSettings",
  "Server settings for the selected READY CyberShuttle session.",
);

function failClosedServerSettings(): ServerConnection.ISettings {
  const baseUrl = new URL(PageConfig.getBaseUrl(), window.location.origin);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(requestUrl(input), baseUrl);
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
      { message: "Select a READY CyberShuttle session first." },
      { status: 503 },
    );
  };
  return ServerConnection.makeSettings({
    appendToken: false,
    baseUrl: baseUrl.toString(),
    fetch,
    token: "",
    wsUrl: baseUrl.toString().replace(/^http/, "ws"),
  });
}

const remoteServerSettingsPlugin: ServiceManagerPlugin<
  ServiceManagerType.IManager["serverSettings"]
> = {
  id: "@cybershuttle/jupyter:remote-server-settings",
  description:
    "Provide a READY cs-control session or the fail-closed controller bootstrap to compute managers.",
  autoStart: true,
  provides: IRemoteServerSettings,
  activate: async () => {
    try {
      const selected = selectedSession();
      if (!selected) {
        throw new Error("No session selected.");
      }
      const access = await new ControlClient().getSessionAccess(
        selected.sessionId,
      );
      cacheSessionAccess(access);
      PageConfig.setOption("terminalsAvailable", "true");
      setActiveSessionId(selected.sessionId);
      return createSessionServerSettings(access);
    } catch {
      PageConfig.setOption("terminalsAvailable", "false");
      setActiveSessionId(undefined);
      const query = new URLSearchParams(window.location.search);
      if (["session", "workspace", "path"].some((key) => query.has(key))) {
        clearAllSessionAccess();
        window.history.replaceState(window.history.state, "", sessionHomeUrl());
      }
      return failClosedServerSettings();
    }
  },
};

const defaultDrivePlugin: ServiceManagerPlugin<Contents.IDrive> = {
  id: "@cybershuttle/jupyter:default-drive",
  description: "Use the selected session's Jupyter Contents REST API.",
  autoStart: true,
  provides: IDefaultDrive,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new Drive({ serverSettings }),
};

const contentsManagerPlugin: ServiceManagerPlugin<Contents.IManager> = {
  id: "@cybershuttle/jupyter:contents-manager",
  description: "Use the selected session's Jupyter Contents REST API manager.",
  autoStart: true,
  provides: IContentsManager,
  requires: [IDefaultDrive, IRemoteServerSettings],
  activate: (_app, defaultDrive, serverSettings) =>
    new ContentsManager({ defaultDrive, serverSettings }),
};

const kernelManagerPlugin: ServiceManagerPlugin<Kernel.IManager> = {
  id: "@cybershuttle/jupyter:kernel-manager",
  description: "Use the selected session's Kernels REST and WebSocket APIs.",
  autoStart: true,
  provides: IKernelManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new KernelManager({ serverSettings }),
};

const kernelSpecManagerPlugin: ServiceManagerPlugin<KernelSpec.IManager> = {
  id: "@cybershuttle/jupyter:kernel-spec-manager",
  description: "Populate kernel specifications from the selected session.",
  autoStart: true,
  provides: IKernelSpecManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) => new KernelSpecManager({ serverSettings }),
};

const sessionManagerPlugin: ServiceManagerPlugin<Session.IManager> = {
  id: "@cybershuttle/jupyter:session-manager",
  description:
    "Points JupyterLab's api/sessions service at the session's server.",
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
  description: "Use terminals only on a selected READY remote session.",
  autoStart: true,
  provides: ITerminalManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) =>
    getActiveSessionId()
      ? new TerminalManager({ serverSettings })
      : new TerminalManager.NoopManager({ serverSettings }),
};

const remoteTerminalUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:remote-terminal-ui",
  description: "Activate JupyterLab terminals only for a READY remote session.",
  autoStart: true,
  requires: [IServiceManager],
  activate: async (app, services) => {
    if (services.terminals.isAvailable()) {
      await app.activatePlugin("@jupyterlab/terminal-extension:plugin");
    }
  },
};

const workspaceManagerPlugin: ServiceManagerPlugin<Workspace.IManager> = {
  id: "@cybershuttle/jupyter:workspace-manager",
  description: "Keep each session's layout in the session's own home.",
  autoStart: true,
  provides: IWorkspaceManager,
  requires: [IRemoteServerSettings],
  activate: (_app, serverSettings) =>
    new RemoteWorkspaces(serverSettings, selectedSession() !== undefined),
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
        standby: getActiveSessionId() ? "when-hidden" : () => true,
      }),
  };

export const remoteServicePlugins = [
  remoteServerSettingsPlugin,
  defaultDrivePlugin,
  contentsManagerPlugin,
  kernelManagerPlugin,
  kernelSpecManagerPlugin,
  sessionManagerPlugin,
  terminalManagerPlugin,
  workspaceManagerPlugin,
  serviceManagerPlugin,
];

export default [
  ...remoteServicePlugins,
  remoteTerminalUiPlugin,
  sessionUiPlugin,
  walltimeStatusPlugin,
];
