import { GENERATION, RUNTIME_ID } from "./Common";
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { ICommandPalette } from "@jupyterlab/apputils";
import { PageConfig } from "@jupyterlab/coreutils";
import type { ReactWidget } from "@jupyterlab/ui-components";
import { BoxPanel, Widget } from "@lumino/widgets";
import { ControlClient, validRuntimeId } from "./ControlClient.js";
import { CyberShuttlePanel } from "./CyberShuttlePanel.js";
import {
  RuntimeController,
  installRuntimeCommandGuard,
} from "./RuntimeController.js";

export const SELECT_RUNTIME_COMMAND = "@cybershuttle/jupyter:select-runtime";

// The pair or nothing: a runtime without a generation names no allocation.
export function selectedRuntime(
  search = window.location.search,
): { runtimeId: string; generation: string } | undefined {
  const query = new URLSearchParams(search);
  const runtimeId = query.get("runtime")?.trim() ?? "";
  const generation = query.get("generation") ?? "";
  return RUNTIME_ID.test(runtimeId) && GENERATION.test(generation)
    ? { runtimeId, generation }
    : undefined;
}

export function runtimeLiteUrl(
  runtimeId: string,
  generation: string,
  documentPath?: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const id = validRuntimeId(runtimeId);
  if (!GENERATION.test(generation))
    throw new Error("Invalid runtime generation.");
  const url = new URL(location.href);
  url.searchParams.set("runtime", id);
  url.searchParams.set("generation", generation);
  documentPath
    ? url.searchParams.set("path", documentPath)
    : url.searchParams.delete("path");
  return url.toString();
}

type MainWidget = Widget & { content: Widget; contentHeader: BoxPanel };

const launcherHeaderHeight = 46;

export const runtimeUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:runtime-ui",
  autoStart: true,
  optional: [ICommandPalette],
  activate: async (app, palette) => {
    const api = new ControlClient(
      PageConfig.getOption("cybershuttleControlApiUrl"),
    );
    const controller = new RuntimeController(
      app,
      api,
      (runtimeId, generation, path) =>
        runtimeLiteUrl(runtimeId, generation, path),
    );
    let panel: CyberShuttlePanel | undefined;
    const asLauncher = (widget: Widget | null): MainWidget | undefined =>
      (widget as MainWidget | null)?.content?.hasClass("jp-Launcher")
        ? (widget as MainWidget)
        : undefined;
    // The title row stays put, so it goes in the main widget's fixed header. The
    // runtimes scroll with the page, so they go in the launcher's own content;
    // mounting them in the header too gave them a second scroll container.
    // ponytail: one await on the launcher's render; if JupyterLab ever renders
    // the launcher content lazily across frames the section silently fails to
    // mount — restore a bounded frame wait then.
    const mountSection = async (launcher: MainWidget): Promise<void> => {
      await (launcher.content as ReactWidget).renderPromise;
      const content = launcher.content.node.querySelector<HTMLElement>(
        ".jp-Launcher-content",
      );
      if (!panel || !content || panel.node.parentElement === content) return;
      // Lumino owns both the insertion and the attach lifecycle: placing the
      // node first makes it connected, which attach then rejects.
      if (panel.isAttached) Widget.detach(panel);
      Widget.attach(panel, content, content.firstElementChild as HTMLElement);
    };

    // JupyterLab disposes a launcher as soon as anything is launched from it,
    // and both widgets are guests in that tree: leave it while its DOM is whole
    // or the header dies with it and the section is stranded off-page.
    const releaseFrom = (launcher: MainWidget): void => {
      if (!panel || !launcher.node.contains(panel.node)) {
        return;
      }
      if (panel.header.parent === launcher.contentHeader) {
        panel.header.parent = null;
      }
      Widget.detach(panel);
    };

    const attachLauncher = (launcher: MainWidget): void => {
      if (!panel || panel.isDisposed) {
        panel = new CyberShuttlePanel(api, controller);
      }
      if (panel.header.parent !== launcher.contentHeader) {
        launcher.contentHeader.addWidget(panel.header);
        // The header region carries no size of its own, so both it and the
        // widget inside it are given the row's height.
        BoxPanel.setSizeBasis(panel.header, launcherHeaderHeight);
        BoxPanel.setSizeBasis(launcher.contentHeader, launcherHeaderHeight);
        launcher.disposed.connect(() => releaseFrom(launcher));
      }
      void mountSection(launcher);
      const lockTitle = () => (launcher.title.closable = false);
      launcher.title.changed.connect(lockTitle, panel);
      lockTitle();
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
    app.commands.addCommand(SELECT_RUNTIME_COMMAND, {
      label: controller.currentRuntimeId
        ? "Switch Remote Runtime…"
        : "Select Remote Runtime…",
      execute: openLauncher,
    });
    palette?.addItem({
      command: SELECT_RUNTIME_COMMAND,
      category: "CyberShuttle",
    });
    installRuntimeCommandGuard(app, controller, SELECT_RUNTIME_COMMAND);
    void app.restored.then(openLauncher);
  },
};
