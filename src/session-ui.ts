// Mounts the CyberShuttle panel into JupyterLab's launcher. The header goes in
// the launcher's fixed content header, the sessions in the scrolling body, where
// a React re-render can drop the foreign node, so a mutation observer re-mounts
// it and release tolerates a node already gone from the document.
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { Dialog, ICommandPalette, showDialog } from "@jupyterlab/apputils";
import type { ReactWidget } from "@jupyterlab/ui-components";
import { BoxPanel, Widget } from "@lumino/widgets";
import { ControlClient, IControlClient } from "./ControlClient";
import { CyberShuttlePanel } from "./CyberShuttlePanel";
import {
  SessionController,
  installSessionCommandGuard,
} from "./SessionController";
import { detach, mount } from "./dom";
import { getActiveSessionId, sessionLiteUrl } from "./session";

const SELECT_SESSION_COMMAND = "@cybershuttle/jupyter:select-session";

type MainWidget = Widget & { content: Widget; contentHeader: BoxPanel };

const launcherHeaderHeight = 46;

async function offerSignIn(panel: CyberShuttlePanel): Promise<void> {
  const body = new Widget();
  body.addClass("csSignInPrompt");
  body.node.innerHTML = `<div class="csSignInLogo" role="img" aria-label="CyberShuttle"></div>
    <p>CyberShuttle Jupyter connects JupyterLab to remote HPC sessions. Sign in to continue.</p>`;
  const result = await showDialog({
    title: "Welcome to CyberShuttle Jupyter",
    body,
    buttons: [Dialog.okButton({ label: "Sign in" })],
  });
  if (result.button.accept) await panel.signIn();
}

export const sessionUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:session-ui",
  description: "Mount the CyberShuttle session panel into the launcher.",
  autoStart: true,
  requires: [IControlClient],
  optional: [ICommandPalette],
  activate: async (
    app,
    api: ControlClient,
    palette: ICommandPalette | null,
  ) => {
    const controller = new SessionController(app, api, sessionLiteUrl);
    let panel: CyberShuttlePanel | undefined;
    let current: MainWidget | undefined;
    const asLauncher = (widget: Widget | null): MainWidget | undefined =>
      (widget as MainWidget | null)?.content?.hasClass("jp-Launcher")
        ? (widget as MainWidget)
        : undefined;
    const mountSection = async (launcher: MainWidget): Promise<void> => {
      await (launcher.content as ReactWidget).renderPromise;
      const content = launcher.content.node.querySelector<HTMLElement>(
        ".jp-Launcher-content",
      );
      if (panel && content) mount(panel, content);
    };

    const releaseFrom = (launcher: MainWidget): void => {
      if (!panel || !launcher.node.contains(panel.node)) {
        return;
      }
      if (panel.header.parent === launcher.contentHeader) {
        panel.header.parent = null;
      }
      detach(panel);
    };

    const wiredLaunchers = new WeakSet<MainWidget>();
    const attachLauncher = (launcher: MainWidget): void => {
      if (!panel || panel.isDisposed) {
        panel = new CyberShuttlePanel(api, controller);
        const candidate = panel;
        void candidate.restored.then(() => {
          if (!candidate.state.signedIn && !location.search) {
            void offerSignIn(candidate);
          }
        });
      }
      if (panel.header.parent !== launcher.contentHeader) {
        launcher.contentHeader.addWidget(panel.header);
        BoxPanel.setSizeBasis(panel.header, launcherHeaderHeight);
        BoxPanel.setSizeBasis(launcher.contentHeader, launcherHeaderHeight);
        if (!wiredLaunchers.has(launcher)) {
          wiredLaunchers.add(launcher);
          const observer = new MutationObserver(() => {
            if (current === launcher) void mountSection(launcher);
          });
          observer.observe(launcher.content.node, {
            childList: true,
            subtree: true,
          });
          launcher.disposed.connect(() => {
            observer.disconnect();
            releaseFrom(launcher);
          });
          launcher.title.changed.connect(
            () => (launcher.title.closable = false),
            panel,
          );
        }
      }
      current = launcher;
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
