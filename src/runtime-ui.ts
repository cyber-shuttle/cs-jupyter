import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { ICommandPalette } from "@jupyterlab/apputils";
import { PageConfig } from "@jupyterlab/coreutils";
import { Widget } from "@lumino/widgets";
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
  if (!/^g-[a-f0-9]{16}$/.test(generation))
    throw new Error("Invalid runtime generation.");
  const url = new URL(location.href);
  url.searchParams.set("runtime", id);
  url.searchParams.set("generation", generation);
  documentPath
    ? url.searchParams.set("path", documentPath)
    : url.searchParams.delete("path");
  return url.toString();
}

type MainWidget = Widget & { content: Widget };

class LiteRuntimeController extends RuntimeController {
  activeRuntimeId: string | undefined;

  override get currentRuntimeId(): string | undefined {
    return this.activeRuntimeId;
  }
}

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
    let contentObserver: MutationObserver | undefined;
    const asLauncher = (widget: Widget | null): MainWidget | undefined =>
      (widget as MainWidget | null)?.content?.hasClass("jp-Launcher")
        ? (widget as MainWidget)
        : undefined;
    // The runtimes belong in the launcher's own scrolling content, beside the
    // sections it renders itself. Mounting them in the content header instead
    // gave them a second scroll container, so a long list scrolled against the
    // rest of the page rather than with it. The launcher re-renders that
    // content, so the node is put back whenever React replaces it.
    const mount = (launcher: MainWidget): void => {
      const content = launcher.content.node.querySelector<HTMLElement>(
        ".jp-Launcher-content",
      );
      if (!panel || !content || panel.node.parentElement === content) return;
      content.insertBefore(panel.node, content.firstChild);
      if (!panel.isAttached) Widget.attach(panel, content);
    };
    const attachLauncher = (launcher: MainWidget): void => {
      if (!panel || panel.isDisposed) {
        panel = new CyberShuttlePanel(api, controller);
      }
      contentObserver?.disconnect();
      mount(launcher);
      contentObserver = new MutationObserver(() => mount(launcher));
      contentObserver.observe(launcher.content.node, {
        childList: true,
        subtree: true,
      });
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
