// Every session this account has run, running ones first, then finished ones.
// The history outlives the cards in it, so a deleted session's run stays, and
// a session's current seq is itself a run entry with no outcome yet.
// RunReport renders one finished entry's accounting, usage and frozen log.
import { RebuildingWidget } from "./RebuildingWidget";
import type { IRun, ISession, SessionState } from "./Common";
import { isTerminal } from "./Common";
import { displayState, type ISessionUiState } from "./session";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import {
  countsDown,
  detailGrid,
  detailGridWithRemaining,
  disclosure,
  element,
  logSection,
  dialogBody,
  statePill,
} from "./dom";
import {
  accountingState,
  runSummary,
  sessionSummary,
  usagePlots,
} from "./metrics";

interface IHistoryEntry {
  key: string;
  sshHost: string;
  state: SessionState;
  run?: IRun;
  session?: ISession;
}

export class RunHistory extends RebuildingWidget {
  private _state: ISessionUiState;
  private _open = new Set<string>();

  constructor(private _panel: CyberShuttlePanel) {
    super();
    this.id = "cybershuttle-run-history";
    this.addClass("csSessionPanel");
    this._state = _panel.state;
    this._panel.stateChanged.connect(this._onStateChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._panel.stateChanged.disconnect(this._onStateChanged, this);
    super.dispose();
  }

  private _onStateChanged(
    _sender: CyberShuttlePanel,
    state: ISessionUiState,
  ): void {
    this._state = state;
    this._render();
  }

  private _entries(): IHistoryEntry[] {
    const running = this._state.sessions
      .filter((session) => !isTerminal(session.state))
      .map((session) => ({
        key: `${session.id}/${session.seq}`,
        sshHost: session.sshHost,
        state: session.state,
        session,
      }));
    const finished = this._state.runs.map((run) => {
      const relaunching = this._state.sessions.find(
        (session) => session.id === run.sessionId && session.seq === run.seq,
      );
      return {
        key: `${run.sessionId}/${run.seq}`,
        sshHost: run.sshHost,
        state: relaunching
          ? displayState(relaunching, this._state.busySessionIds)
          : run.finalState,
        run,
      };
    });
    return [...running, ...finished];
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Every session you have run, still running first. A run is kept even after its card is deleted.",
      this._state.error,
    );
    const entries = this._entries();
    for (const entry of entries) {
      card.appendChild(this._entry(entry));
    }
    if (entries.length === 0) {
      card.appendChild(element("div", "No runs yet.", "csStatus"));
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  protected _counting(): boolean {
    return this._entries().some(
      (entry) => entry.session && countsDown(entry.session),
    );
  }

  private _entry(entry: IHistoryEntry): HTMLElement {
    const { entry: element_, body } = disclosure(entry.key, this._open, [
      element("span", entry.sshHost, "csCardTitle"),
      element("span", this._when(entry), "csMeta csSshHostTarget"),
      statePill(entry.state),
    ]);
    element_.querySelector("summary")!.dataset.sessionAction = entry.key;
    body.appendChild(
      entry.run ? RunReport(entry.run) : this._inFlight(entry.session!),
    );
    return element_;
  }

  private _when(entry: IHistoryEntry): string {
    if (entry.run) {
      return new Date(entry.run.endedAt).toLocaleString();
    }
    const started = entry.session?.startedAt;
    return started
      ? `started ${new Date(started).toLocaleString()}`
      : "not started yet";
  }

  private _inFlight(session: ISession): HTMLElement {
    const section = element("section", "", "csRunReport");
    const columns = element("div", "", "csDetailColumns");
    const rows: Array<[string, string]> = [
      ["State", session.state],
      ...sessionSummary(session),
    ];
    const grid = detailGridWithRemaining(rows, session);
    columns.appendChild(grid);
    const samples = this._state.samples.get(session.id) ?? [];
    if (samples.length) {
      columns.appendChild(usagePlots(session, samples, "latest"));
    }
    section.appendChild(columns);
    return section;
  }
}

export function RunReport(run: IRun): HTMLElement {
  const section = element("section", "", "csRunReport");
  section.appendChild(element("h4", "Run report", "csSessionLogTitle"));
  const columns = element("div", "", "csDetailColumns");
  columns.appendChild(detailGrid(runSummary(run)));
  const samples = run.samples ?? [];
  if (samples.length) {
    columns.appendChild(usagePlots(run, samples, "peak"));
  }
  section.appendChild(columns);
  const accounting = accountingState(run, Date.now());
  if (accounting !== "present") {
    section.appendChild(
      element(
        "div",
        accounting === "pending"
          ? "Slurm's accounting for this run has not flushed yet; peak memory and efficiency will appear here."
          : "Slurm recorded no accounting for this run, so peak memory and efficiency are unknown.",
        "csStatus",
      ),
    );
  }
  if (run.error) {
    section.appendChild(element("div", run.error, "csError"));
  }
  const logs = run.logs ?? [];
  if (logs.length) {
    section.appendChild(logSection(logs).section);
  }
  return section;
}
