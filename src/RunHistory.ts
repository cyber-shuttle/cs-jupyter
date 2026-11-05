// Every run of this account's sessions, running ones first, then finished ones.
// A live session is itself an entry with no outcome yet. RunReport renders one
// finished entry's summary and frozen log.
import { PanelBoundWidget } from "./RebuildingWidget";
import type { ILogLine, ISession, SessionState } from "./Common";
import { isTerminal } from "./Common";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import { sessionTitle } from "./session";
import {
  countsDown,
  detailColumns,
  detailGrid,
  detailGridWithRemaining,
  disclosure,
  element,
  logSection,
  dialogBody,
  statePill,
} from "./dom";
import { runSummary, sessionSummary, usagePlots, when } from "./usage";

interface IHistoryEntry {
  key: string;
  title: string;
  state: SessionState;
  run?: ISession;
  session?: ISession;
}

export class RunHistory extends PanelBoundWidget {
  private _open = new Set<string>();

  constructor(panel: CyberShuttlePanel, open?: string) {
    super(panel);
    this.id = "cybershuttle-run-history";
    this.addClass("csSessionPanel");
    if (open) this._open.add(open);
    this._render();
  }

  private _entries(): IHistoryEntry[] {
    const title = (run: ISession) => sessionTitle(this._state, run);
    const running = this._state.sessions
      .filter((session) => !isTerminal(session.state))
      .map((session) => ({
        key: session.id,
        title: title(session),
        state: session.state,
        session,
      }));
    const finished = this._state.runs.map((run) => ({
      key: run.id,
      title: title(run),
      state: run.state,
      run,
    }));
    return [...running, ...finished];
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Every run of your sessions, running ones first.",
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
      element("span", entry.title, "csCardTitle"),
      element("span", this._when(entry), "csMeta csSshHostTarget"),
      statePill(entry.state),
    ]);
    element_.querySelector("summary")!.dataset.sessionAction = entry.key;
    const run = entry.run;
    const load = (): void => {
      if (run && element_.open) this._logIds.add(run.id);
    };
    element_.addEventListener("toggle", load);
    load();
    body.appendChild(
      run
        ? RunReport(run, this._state.logs.get(run.id)?.lines)
        : this._inFlight(entry.session!),
    );
    return element_;
  }

  private _when(entry: IHistoryEntry): string {
    if (entry.run) {
      return when(entry.run.updatedAt);
    }
    const started = entry.session?.startedAt;
    return started
      ? `started ${new Date(started).toLocaleString()}`
      : "not started yet";
  }

  private _inFlight(session: ISession): HTMLElement {
    const section = element("section", "", "csRunReport");
    const rows: Array<[string, string]> = [
      ["State", session.state],
      ...sessionSummary(session),
    ];
    const samples = this._state.samples.get(session.id) ?? [];
    section.appendChild(
      detailColumns(
        detailGridWithRemaining(rows, session),
        samples.length ? usagePlots(session, samples) : undefined,
      ),
    );
    return section;
  }
}

export function RunReport(run: ISession, logs: ILogLine[] = []): HTMLElement {
  const section = element("section", "", "csRunReport");
  section.appendChild(element("h4", "Run report", "csSessionLogTitle"));
  section.appendChild(detailGrid(runSummary(run)));
  if (run.error) {
    section.appendChild(element("div", run.error, "csError"));
  }
  if (logs.length) {
    section.appendChild(logSection(logs).section);
  }
  return section;
}
