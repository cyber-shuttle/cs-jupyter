// Every run of this account's sessions, keyed by the run's processId: each live
// session's current run first, in list order, then every other run by when it
// ended, newest first. A live session's current run renders in flight, with no
// outcome yet; RunReport renders any other run's summary and frozen log.
import { PanelBoundWidget } from "./RebuildingWidget";
import type { ILogLine, IRun, ISession } from "./Common";
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
  session: ISession;
  run: IRun;
  inFlight: boolean;
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
    const entries = this._state.sessions.flatMap((session) =>
      session.runs.map((run, index) => ({
        session,
        run,
        inFlight: session.live && index === 0,
      })),
    );
    return [
      ...entries.filter((each) => each.inFlight),
      ...entries
        .filter((each) => !each.inFlight)
        .sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0)),
    ];
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
      (entry) => entry.inFlight && countsDown(entry.session),
    );
  }

  private _entry({ session, run, inFlight }: IHistoryEntry): HTMLElement {
    const { entry: element_, body } = disclosure(run.processId, this._open, [
      element("span", sessionTitle(this._state, session), "csCardTitle"),
      element("span", this._when(run, inFlight), "csMeta csSshHostTarget"),
      statePill(run.state),
    ]);
    element_.querySelector("summary")!.dataset.sessionAction = run.processId;
    const load = (): void => {
      if (!inFlight && element_.open) this._logIds.add(run.processId);
    };
    element_.addEventListener("toggle", load);
    load();
    body.appendChild(
      inFlight
        ? this._inFlight(session)
        : RunReport(run, this._state.logs.get(run.processId)?.lines),
    );
    return element_;
  }

  private _when(run: IRun, inFlight: boolean): string {
    if (!inFlight) {
      return when(run.endedAt);
    }
    return run.startedAt
      ? `started ${new Date(run.startedAt).toLocaleString()}`
      : "not started yet";
  }

  private _inFlight(session: ISession): HTMLElement {
    const section = element("section", "", "csRunReport");
    const rows: Array<[string, string]> = [
      ["State", session.state],
      ...sessionSummary(session),
    ];
    const samples = this._state.samples.get(session.sessionId) ?? [];
    section.appendChild(
      detailColumns(
        detailGridWithRemaining(rows, session),
        samples.length ? usagePlots(session, samples) : undefined,
      ),
    );
    return section;
  }
}

export function RunReport(run: IRun, logs: ILogLine[] = []): HTMLElement {
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
