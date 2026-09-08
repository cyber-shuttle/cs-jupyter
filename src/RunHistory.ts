import { Widget } from "@lumino/widgets";
import type { IRun, IRuntime } from "./Common";
import { isTerminal } from "./Common";
import type { CyberShuttlePanel, IRuntimeUiState } from "./CyberShuttlePanel";
import { element, statePill } from "./dom";
import { RunReport } from "./RunReport";
import { countsDown, formatRemaining, remainingMs } from "./walltime";

// One allocation, finished or in flight. A run is a generation, so the
// generation a card is on now is a run like any other -- it simply has no
// outcome yet, and saying it stopped would be a lie.
interface IHistoryEntry {
  key: string;
  sshHost: string;
  state: string;
  run?: IRun;
  runtime?: IRuntime;
}

/**
 * Every allocation this account has run, newest first: the ones still going,
 * then the ones that finished. The history outlives the cards in it, so a run
 * whose runtime was deleted is still here.
 */
export class RunHistory extends Widget {
  private _state: IRuntimeUiState;
  // Keyed by generation, so a re-render leaves the reader where they were.
  private _open = new Set<string>();

  constructor(private _controller: CyberShuttlePanel) {
    super();
    this.id = "cybershuttle-run-history";
    this.addClass("csRuntimePanel");
    this._state = _controller.state;
    this._controller.stateChanged.connect(this._onStateChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._controller.stateChanged.disconnect(this._onStateChanged, this);
    super.dispose();
  }

  private _onStateChanged(
    _sender: CyberShuttlePanel,
    state: IRuntimeUiState,
  ): void {
    this._state = state;
    this._render();
  }

  // A live allocation is listed under the generation it is on; the runs behind
  // it are the generations that already ended.
  private _entries(): IHistoryEntry[] {
    const running = this._state.runtimes
      .filter((runtime) => !isTerminal(runtime.state) && runtime.generation)
      .map((runtime) => ({
        key: `${runtime.id}/${runtime.generation}`,
        sshHost: runtime.sshHost,
        state: runtime.state,
        runtime,
      }));
    const finished = this._state.runs.map((run) => ({
      key: `${run.runtimeId}/${run.generation}`,
      sshHost: run.sshHost,
      state: run.finalState,
      run,
    }));
    return [...running, ...finished];
  }

  private _render(): void {
    this.node.textContent = "";
    const root = element("div", "", "csRoot csScrollRoot");
    root.append(
      element(
        "div",
        "Every allocation you have run, newest first. A run is kept even after its card is deleted.",
        "csModalSubtitle",
      ),
      element("hr", "", "csModalRule"),
    );
    const scroll = element("div", "", "csModalScroll");
    if (this._state.error) {
      scroll.appendChild(element("div", this._state.error, "csError"));
    }
    const card = element("div", "", "csCard");
    const entries = this._entries();
    for (const entry of entries) {
      card.appendChild(this._entry(entry));
    }
    if (entries.length === 0) {
      card.appendChild(element("div", "No runs yet.", "csStatus"));
    }
    scroll.appendChild(card);
    root.appendChild(scroll);
    this.node.appendChild(root);
  }

  private _entry(entry: IHistoryEntry): HTMLElement {
    const element_ = document.createElement("details");
    element_.className = "csSshHostEntry";
    element_.open = this._open.has(entry.key);
    element_.ontoggle = () =>
      element_.open ? this._open.add(entry.key) : this._open.delete(entry.key);
    const summary = document.createElement("summary");
    summary.className = "csSshHostSummary";
    summary.append(
      element("span", entry.sshHost, "csCardTitle"),
      element("span", this._when(entry), "csMeta csSshHostTarget"),
      statePill(entry.state),
    );
    const body = element("div", "", "csSshHostBody");
    body.appendChild(
      entry.run ? RunReport(entry.run) : this._inFlight(entry.runtime!),
    );
    element_.append(summary, body);
    return element_;
  }

  private _when(entry: IHistoryEntry): string {
    if (entry.run) {
      return new Date(entry.run.endedAt).toLocaleString();
    }
    const started = entry.runtime?.startedAt;
    return started
      ? `started ${new Date(started).toLocaleString()}`
      : "not started yet";
  }

  // An allocation still going has no report yet, and its card already carries
  // the shape of it. All this has to add is that it is still going.
  private _inFlight(runtime: IRuntime): HTMLElement {
    const left = countsDown(runtime)
      ? `${formatRemaining(remainingMs(runtime, Date.now()))} left`
      : "waiting for the scheduler";
    return element("div", `Still running \u2014 ${left}.`, "csStatus");
  }
}
