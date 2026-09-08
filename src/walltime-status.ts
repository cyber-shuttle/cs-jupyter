import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { PageConfig } from "@jupyterlab/coreutils";
import { IStatusBar } from "@jupyterlab/statusbar";
import { Widget } from "@lumino/widgets";
import type { IRuntime } from "./Common";
import { ControlClient } from "./ControlClient";
import { element } from "./dom";
import { selectedRuntime } from "./runtime-ui";
import {
  LOW_TIME_MS,
  countsDown,
  formatRemaining,
  remainingMs,
} from "./walltime";

// Slurm moves the anchor only when it starts the job, so the seconds between
// refreshes are arithmetic. Re-read no more often than cs-control's own
// background reconciliation runs.
const REFRESH_MS = 30_000;

// The countdown for the runtime this page is attached to. The launcher is
// disposed the moment anything is opened from it, so this reads cs-control
// itself rather than borrowing the panel's state.
export class WalltimeStatus extends Widget {
  private _runtime: IRuntime | undefined;
  private _clock: number | undefined;
  private _refresh: number | undefined;

  constructor(
    private _api: ControlClient,
    private _runtimeId: string,
  ) {
    super();
    this.addClass("csWalltimeStatus");
    this._render();
    void this._reload();
    this._refresh = window.setInterval(() => void this._reload(), REFRESH_MS);
    this._clock = window.setInterval(() => this._render(), 1000);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    window.clearInterval(this._clock);
    window.clearInterval(this._refresh);
    super.dispose();
  }

  private async _reload(): Promise<void> {
    try {
      const runtime = await this._api.getRuntime(this._runtimeId);
      if (!this.isDisposed) {
        this._runtime = runtime;
        this._render();
      }
    } catch {
      // A failed read leaves the last anchor in place: the deadline it names is
      // still the truth, and a blank status bar would say less than a stale one.
    }
  }

  private _render(): void {
    const runtime = this._runtime;
    // Nothing to count for a queued, stopping or finished allocation, and an
    // empty status-bar item is noise.
    this.setHidden(!runtime || !countsDown(runtime));
    if (!runtime || !countsDown(runtime)) {
      return;
    }
    const left = remainingMs(runtime, Date.now());
    this.toggleClass("csWalltimeStatusLow", left <= LOW_TIME_MS);
    this.title.label = `${formatRemaining(left)} left`;
    this.title.caption = `${runtime.sshHost}: ${formatRemaining(left)} of the ${runtime.resources.wallMinutes}-minute allocation left`;
    this.node.textContent = "";
    const item = element("span", "", "csWalltimeStatusItem");
    item.innerHTML = CLOCK_GLYPH;
    item.append(element("span", `${formatRemaining(left)} left`));
    item.title = this.title.caption;
    this.node.appendChild(item);
  }
}

const CLOCK_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.9V8l2.1 1.6" /></g></svg>`;

export const walltimeStatusPlugin: JupyterFrontEndPlugin<void> = {
  id: "@cybershuttle/jupyter:walltime-status",
  description:
    "Count the selected session's remaining walltime down in the status bar.",
  autoStart: true,
  requires: [IStatusBar],
  activate: (_app, statusBar: IStatusBar) => {
    const selected = selectedRuntime();
    if (!selected) {
      return;
    }
    statusBar.registerStatusItem("@cybershuttle/jupyter:walltime-status", {
      align: "right",
      rank: 100,
      item: new WalltimeStatus(
        new ControlClient(PageConfig.getOption("cybershuttleControlApiUrl")),
        selected.runtimeId,
      ),
    });
  },
};
