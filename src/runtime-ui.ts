import { GENERATION } from "./Common";
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { ICommandPalette } from "@jupyterlab/apputils";
import { PageConfig } from "@jupyterlab/coreutils";
import { BoxPanel, Widget } from "@lumino/widgets";
import { ControlClient, validRuntimeId } from "./ControlClient.js";
import { CyberShuttlePanel } from "./CyberShuttlePanel.js";
import {
  RuntimeController,
  installRuntimeCommandGuard,
} from "./RuntimeController.js";
import { getActiveRuntimeId } from "./runtime-state.js";

export const SELECT_RUNTIME_COMMAND = "@cybershuttle/jupyter:select-runtime";

export function resolveRuntimeId(
  search = window.location.search,
): string | undefined {
  const value = new URLSearchParams(search).get("runtime")?.trim();
  try {
    return value ? validRuntimeId(value) : undefined;
  } catch {
    return undefined;
  }
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

class LiteRuntimeController extends RuntimeController {
  activeRuntimeId: string | undefined;

  override get currentRuntimeId(): string | undefined {
    return this.activeRuntimeId;
  }
}

const launcherHeaderHeight = 46;

export const runtimeUiPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:runtime-ui",
  autoStart: true,
  optional: [ICommandPalette],
  activate: async (app, palette) => {
    const api = new ControlClient(
      PageConfig.getOption("cybershuttleControlApiUrl"),
    );
    const controller = new LiteRuntimeController(
      app,
      api,
      (runtimeId, generation, path) =>
        runtimeLiteUrl(runtimeId, generation, path),
    );
    controller.activeRuntimeId = getActiveRuntimeId();
    let panel: CyberShuttlePanel | undefined;
    const asLauncher = (widget: Widget | null): MainWidget | undefined =>
      (widget as MainWidget | null)?.content?.hasClass("jp-Launcher")
        ? (widget as MainWidget)
        : undefined;
    // The title row stays put, so it goes where a main-area widget keeps a
    // fixed header. The runtimes scroll with the page, so they go into the
    // launcher's own content beside the sections it renders itself; mounting
    // them in the header too gave them a second scroll container and a long
    // list scrolled against the rest of the page rather than with it.
    // The launcher renders its content asynchronously, so the section waits for
    // that content to exist rather than watching the DOM for it.
    const mountSection = async (launcher: MainWidget): Promise<void> => {
      for (let frame = 0; panel && frame < 60; frame += 1) {
        const content = launcher.content.node.querySelector<HTMLElement>(
          ".jp-Launcher-content",
        );
        if (content) {
          if (panel.node.parentElement !== content) {
            // Lumino owns both the insertion and the attach lifecycle: placing
            // the node first makes it connected, which attach then rejects.
            if (panel.isAttached) Widget.detach(panel);
            Widget.attach(
              panel,
              content,
              content.firstElementChild as HTMLElement,
            );
          }
          return;
        }
        await new Promise(requestAnimationFrame);
      }
    };

    // JupyterLab disposes a launcher the moment anything is launched from it,
    // and both of our widgets are guests in that tree: the header is a child of
    // a panel about to be disposed, and the section is attached to a node about
    // to leave the page. Leaving on our own while the tree is still whole is
    // what lets the next launcher receive them.
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
