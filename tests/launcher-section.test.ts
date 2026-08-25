import { MainAreaWidget } from "@jupyterlab/apputils";
import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import { describe, expect, it, vi } from "vitest";
import { runtimeUiPlugin } from "../src/runtime-ui";

class LauncherContent extends Widget {
  constructor() {
    super();
    this.addClass("jp-Launcher");
    this.node.innerHTML =
      '<div class="jp-Launcher-body"><div class="jp-Launcher-content"><div class="jp-Launcher-cwd"></div></div></div>';
  }
}

function launcher(id: string): MainAreaWidget<LauncherContent> {
  const main = new MainAreaWidget({ content: new LauncherContent() });
  main.id = id;
  Widget.attach(main, document.body);
  return main;
}

function section(main: MainAreaWidget<LauncherContent>): Element | null {
  return main.node.querySelector(".jp-Launcher-content > .csShell");
}

async function settle(): Promise<void> {
  for (let frame = 0; frame < 5; frame += 1) {
    await new Promise(requestAnimationFrame);
  }
}

describe("runtimes section across launchers", () => {
  it("follows the launcher JupyterLab disposes when something is launched", async () => {
    const first = launcher("launcher-1");
    const currentChanged = new Signal<unknown, { newValue: Widget | null }>({});
    const app = {
      commands: {
        addCommand: vi.fn(),
        execute: vi.fn(),
        hasCommand: () => true,
      },
      shell: {
        currentWidget: first as Widget,
        widgets: () => [first as Widget].values(),
        activateById: vi.fn(),
        currentChanged,
      },
      restored: Promise.resolve(),
    };

    await runtimeUiPlugin.activate(app as never, null);
    await settle();
    expect(section(first)).not.toBeNull();
    const header = first.contentHeader.widgets[0];
    expect(header).toBeDefined();

    // Launching anything disposes the launcher it was launched from.
    first.content.dispose();
    expect(first.isDisposed).toBe(true);
    expect(header.isDisposed).toBe(false);

    const next = launcher("launcher-2");
    currentChanged.emit({ newValue: next });
    await settle();
    expect(section(next)).not.toBeNull();
    expect(next.contentHeader.widgets[0]).toBe(header);
  });
});
