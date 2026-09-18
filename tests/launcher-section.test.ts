// JupyterLab disposes a launcher once anything is launched from it. The sessions
// section and its header must follow to whatever launcher becomes current.
import { MainAreaWidget } from "@jupyterlab/apputils";
import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import { describe, expect, it, vi } from "vitest";
import { sessionUiPlugin } from "../src/session-ui";
import { fakeApp } from "./fakes";

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

describe("sessions section across launchers", () => {
  it("follows the launcher JupyterLab disposes when something is launched", async () => {
    const first = launcher("launcher-1");
    const currentChanged = new Signal<unknown, { newValue: Widget | null }>({});
    const app = fakeApp(first, currentChanged);

    await sessionUiPlugin.activate(app as never, null);
    await settle();
    expect(section(first)).not.toBeNull();
    const header = first.contentHeader.widgets[0];
    expect(header).toBeDefined();

    first.content.dispose();
    expect(first.isDisposed).toBe(true);
    expect(header.isDisposed).toBe(false);

    const next = launcher("launcher-2");
    currentChanged.emit({ newValue: next });
    await settle();
    expect(section(next)).not.toBeNull();
    expect(next.contentHeader.widgets[0]).toBe(header);
  });

  it("re-mounts the section after the launcher re-renders its content without it", async () => {
    const first = launcher("launcher-3");
    const currentChanged = new Signal<unknown, { newValue: Widget | null }>({});
    const app = fakeApp(first, currentChanged);

    await sessionUiPlugin.activate(app as never, null);
    await settle();
    expect(section(first)).not.toBeNull();

    first.content.node.querySelector(".jp-Launcher-body")!.innerHTML =
      '<div class="jp-Launcher-content"><div class="jp-Launcher-cwd"></div></div>';
    expect(section(first)).toBeNull();
    await settle();
    expect(section(first)).not.toBeNull();
  });

  it("connects title.changed once per launcher when alternating between two", async () => {
    const first = launcher("launcher-4");
    const second = launcher("launcher-5");
    const currentChanged = new Signal<unknown, { newValue: Widget | null }>({});
    const app = fakeApp(first, currentChanged);
    const firstConnectSpy = vi.spyOn(first.title.changed, "connect");
    const secondConnectSpy = vi.spyOn(second.title.changed, "connect");

    await sessionUiPlugin.activate(app as never, null);
    await settle();
    currentChanged.emit({ newValue: second });
    await settle();
    currentChanged.emit({ newValue: first });
    await settle();
    currentChanged.emit({ newValue: second });
    await settle();

    expect(firstConnectSpy).toHaveBeenCalledTimes(1);
    expect(secondConnectSpy).toHaveBeenCalledTimes(1);
  });
});
