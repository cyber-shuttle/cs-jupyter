// Status-bar countdown for the session this page is attached to. It reads
// cs-control directly, since the launcher panel is disposed once anything
// opens. The item hides entirely for a queued, stopping or finished session.
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { IStatusBar } from "@jupyterlab/statusbar";
import { Widget } from "@lumino/widgets";
import type { ISession } from "./Common";
import { ControlClient } from "./ControlClient";
import { Clock, CLOCK_GLYPH, element } from "./dom";
import { selectedSession } from "./session-state";
import { countsDown, remainingBadge } from "./walltime";

const REFRESH_MS = 30_000;

export class WalltimeStatus extends Widget {
  private _session: ISession | undefined;
  private _clock = new Clock(() => this._render());
  private _refresh: number | undefined;

  constructor(
    private _api: ControlClient,
    private _sessionId: string,
  ) {
    super();
    this.addClass("csWalltimeStatus");
    this._render();
    void this._reload();
    this._refresh = window.setInterval(() => void this._reload(), REFRESH_MS);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._clock.stop();
    window.clearInterval(this._refresh);
    super.dispose();
  }

  private async _reload(): Promise<void> {
    try {
      const session = await this._api.getSession(this._sessionId);
      if (!this.isDisposed) {
        this._session = session;
        this._render();
      }
    } catch {}
  }

  private _render(): void {
    const session = this._session;
    const counting = !!session && countsDown(session);
    this._clock.sync(counting);
    this.setHidden(!counting);
    if (!session || !counting) {
      return;
    }
    const { label, low } = remainingBadge(session, Date.now());
    this.toggleClass("csWalltimeStatusLow", low);
    const caption = `${session.sshHost}: ${label} of the session's ${session.resources.wallMinutes} minutes left`;
    this.node.textContent = "";
    const item = element("span", "", "csWalltimeStatusItem");
    item.innerHTML = CLOCK_GLYPH;
    item.append(element("span", label));
    item.title = caption;
    this.node.appendChild(item);
  }
}

export const walltimeStatusPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:walltime-status",
  description:
    "Count the selected session's remaining walltime down in the status bar.",
  autoStart: true,
  requires: [IStatusBar],
  activate: (_app, statusBar: IStatusBar) => {
    const selected = selectedSession();
    if (!selected) {
      return;
    }
    statusBar.registerStatusItem("@cybershuttle/jupyter:walltime-status", {
      align: "right",
      rank: 100,
      item: new WalltimeStatus(new ControlClient(), selected.sessionId),
    });
  },
};
