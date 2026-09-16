// Mounts the CyberShuttle panel into JupyterLab's launcher. The header goes in
// the launcher's fixed content header, the sessions in the scrolling body. Both
// widgets must be released before the launcher's DOM goes, or they are stranded
// with it.
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { ICommandPalette } from "@jupyterlab/apputils";
import type { ReactWidget } from "@jupyterlab/ui-components";
import { BoxPanel, Widget } from "@lumino/widgets";
import { ControlClient } from "./ControlClient.js";
import { CyberShuttlePanel } from "./CyberShuttlePanel.js";
import {
  SessionController,
  installSessionCommandGuard,
} from "./SessionController.js";
import { getActiveSessionId, sessionLiteUrl } from "./session-state.js";

const SELECT_SESSION_COMMAND = "@cybershuttle/jupyter:select-session";

type MainWidget = Widget & { content: Widget; contentHeader: BoxPanel };

const launcherHeaderHeight = 46;

export const sessionUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:session-ui",
  autoStart: true,
  optional: [ICommandPalette],
  activate: async (app, palette) => {
    const api = new ControlClient();
    const controller = new SessionController(app, api, sessionLiteUrl);
    let panel: CyberShuttlePanel | undefined;
    const asLauncher = (widget: Widget | null): MainWidget | undefined =>
      (widget as MainWidget | null)?.content?.hasClass("jp-Launcher")
        ? (widget as MainWidget)
        : undefined;
    const mountSection = async (launcher: MainWidget): Promise<void> => {
      await (launcher.content as ReactWidget).renderPromise;
      const content = launcher.content.node.querySelector<HTMLElement>(
        ".jp-Launcher-content",
      );
      if (!panel || !content || panel.node.parentElement === content) return;
      if (panel.isAttached) Widget.detach(panel);
      Widget.attach(panel, content, content.firstElementChild as HTMLElement);
    };

    const releaseFrom = (launcher: MainWidget): void => {
      if (!panel || !launcher.node.contains(panel.node)) {
        return;
      }
      if (panel.header.parent === launcher.contentHeader) {
        panel.header.parent = null;
      }
      Widget.detach(panel);
    };

    const wiredLaunchers = new WeakSet<MainWidget>();
    const attachLauncher = (launcher: MainWidget): void => {
      if (!panel || panel.isDisposed) {
        panel = new CyberShuttlePanel(api, controller);
      }
      if (panel.header.parent !== launcher.contentHeader) {
        launcher.contentHeader.addWidget(panel.header);
        BoxPanel.setSizeBasis(panel.header, launcherHeaderHeight);
        BoxPanel.setSizeBasis(launcher.contentHeader, launcherHeaderHeight);
        if (!wiredLaunchers.has(launcher)) {
          wiredLaunchers.add(launcher);
          launcher.disposed.connect(() => releaseFrom(launcher));
          launcher.title.changed.connect(
            () => (launcher.title.closable = false),
            panel,
          );
        }
      }
      void mountSection(launcher);
      launcher.title.closable = false;
    };
    const openLauncher = async () => {
      const launcher =
        asLauncher(app.shell.currentWidget) ??
        Array.from(app.shell.widgets("main")).map(asLauncher).find(Boolean) ??
        ((await app.commands.execute("launcher:create", {
          activate: true,
        })) as MainWidget);
      attachLauncher(launcher);
      app.shell.activateById(launcher.id);
    };
    app.shell.currentChanged?.connect((_sender, { newValue }) => {
      const launcher = asLauncher(newValue);
      if (launcher) attachLauncher(launcher);
    });
    app.commands.addCommand(SELECT_SESSION_COMMAND, {
      label: getActiveSessionId() ? "Switch Session…" : "Select Session…",
      execute: openLauncher,
    });
    palette?.addItem({
      command: SELECT_SESSION_COMMAND,
      category: "CyberShuttle",
    });
    installSessionCommandGuard(app, controller, SELECT_SESSION_COMMAND);
    void app.restored.then(openLauncher);
  },
};
