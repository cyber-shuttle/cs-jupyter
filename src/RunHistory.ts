import { Widget } from "@lumino/widgets";
import type { IRun } from "./Common";
import { ControlClient, errorMessage } from "./ControlClient";
import { element, statePill } from "./dom";
import { RunReport } from "./RunReport";

/**
 * Every allocation this account has finished, newest first. The history
 * outlives the cards in it, so a run whose runtime was deleted is still here.
 */
export class RunHistory extends Widget {
  private _runs: IRun[] = [];
  private _busy = false;
  private _error = "";
  // Keyed by generation, so a re-render leaves the reader where they were.
  private _open = new Set<string>();

  constructor(private _api: ControlClient) {
    super();
    this.id = "cybershuttle-run-history";
    this.addClass("csRuntimePanel");
    this._render();
  }

  async refresh(): Promise<void> {
    this._busy = true;
    this._error = "";
    this._render();
    try {
      this._runs = await this._api.listRuns();
    } catch (error) {
      this._error = errorMessage(error);
    } finally {
      this._busy = false;
      if (!this.isDisposed) {
        this._render();
      }
    }
  }

  private _render(): void {
    this.node.textContent = "";
    const root = element("div", "", "csRoot csScrollRoot");
    root.append(
      element(
        "div",
        "Every allocation you have finished, newest first. A run is kept even after its card is deleted.",
        "csModalSubtitle",
      ),
      element("hr", "", "csModalRule"),
    );
    const scroll = element("div", "", "csModalScroll");
    if (this._error) {
      scroll.appendChild(element("div", this._error, "csError"));
    }
    const card = element("div", "", "csCard");
    for (const run of this._runs) {
      card.appendChild(this._entry(run));
    }
    if (!this._busy && this._runs.length === 0) {
      card.appendChild(
        element("div", "No runs have finished yet.", "csStatus"),
      );
    }
    scroll.appendChild(card);
    root.appendChild(scroll);
    this.node.appendChild(root);
  }

  private _entry(run: IRun): HTMLElement {
    const entry = document.createElement("details");
    entry.className = "csSshHostEntry";
    entry.open = this._open.has(run.generation);
    entry.ontoggle = () =>
      entry.open
        ? this._open.add(run.generation)
        : this._open.delete(run.generation);
    const summary = document.createElement("summary");
    summary.className = "csSshHostSummary";
    summary.append(
      element("span", run.sshHost, "csCardTitle"),
      element(
        "span",
        new Date(run.endedAt).toLocaleString(),
        "csMeta csSshHostTarget",
      ),
      statePill(run.finalState),
    );
    const body = element("div", "", "csSshHostBody");
    // The report is built once and read the same way wherever it appears.
    body.appendChild(RunReport(run));
    entry.append(summary, body);
    return entry;
  }
}
