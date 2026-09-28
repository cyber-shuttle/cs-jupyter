// Every run of this account's sessions, running ones first, then finished ones.
// The history outlives the sessions in it, so a deleted session's run stays,
// and a session's current run is itself an entry with no outcome yet.
// RunReport renders one finished entry's accounting, usage and frozen log.
import { PanelBoundWidget } from "./RebuildingWidget";
import type { IRun, ISession, SessionState } from "./Common";
import { isTerminal, PLATFORM_LABEL, PLATFORMS } from "./Common";
import { displayState } from "./session";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import {
  button,
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
import {
  accountingState,
  runSummary,
  sessionSummary,
  usagePlots,
} from "./usage";

const PLATFORM_OPTIONS: Array<[string, string]> = [
  ["", "All"],
  ...PLATFORMS.map((p): [string, string] => [p, PLATFORM_LABEL[p]]),
];

interface IHistoryEntry {
  key: string;
  alias: string;
  state: SessionState;
  run?: IRun;
  session?: ISession;
}

export class RunHistory extends PanelBoundWidget {
  private _open = new Set<string>();
  private _platform = "";

  constructor(panel: CyberShuttlePanel, open?: string) {
    super(panel);
    this.id = "cybershuttle-run-history";
    this.addClass("csSessionPanel");
    if (open) this._open.add(open);
    this._render();
  }

  private _entries(): IHistoryEntry[] {
    const shown = (p?: string) => !this._platform || p === this._platform;
    const running = this._state.sessions
      .filter(
        (session) => !isTerminal(session.state) && shown(session.platform),
      )
      .map((session) => ({
        key: `${session.id}/${session.seq}`,
        alias: session.alias,
        state: session.state,
        session,
      }));
    const finished = this._state.runs
      .filter((run) => shown(run.platform))
      .map((run) => {
        const starting = this._state.sessions.find(
          (session) => session.id === run.sessionId && session.seq === run.seq,
        );
        return {
          key: `${run.sessionId}/${run.seq}`,
          alias: run.alias,
          state: starting
            ? displayState(starting, this._state.busySessionIds)
            : run.finalState,
          run,
        };
      });
    return [...running, ...finished];
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Every run of your sessions, running ones first. A run is kept even after its session is deleted.",
      this._state.error,
    );
    // Buttons, not a select: the countdown rebuilds this every second, which
    // would close an open dropdown.
    const platforms = element("div", "", "csPlatformFilter");
    for (const [value, label] of PLATFORM_OPTIONS) {
      const chosen = value === this._platform;
      const choice = button(
        label,
        chosen ? "csPrimaryButton" : "csSecondaryButton",
        () => {
          this._platform = value;
          this._render();
        },
      );
      choice.setAttribute("aria-pressed", String(chosen));
      choice.dataset.sessionAction = `platform-${value || "all"}`;
      platforms.appendChild(choice);
    }
    scroll.appendChild(platforms);
    const entries = this._entries();
    for (const entry of entries) {
      card.appendChild(this._entry(entry));
    }
    if (entries.length === 0) {
      card.appendChild(
        element(
          "div",
          this._platform ? "No runs on this platform." : "No runs yet.",
          "csStatus",
        ),
      );
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
      element("span", entry.alias, "csCardTitle"),
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
    const rows: Array<[string, string]> = [
      ["State", session.state],
      ...sessionSummary(session),
    ];
    const samples = this._state.samples.get(session.id) ?? [];
    section.appendChild(
      detailColumns(
        detailGridWithRemaining(rows, session),
        samples.length ? usagePlots(session, samples, "latest") : undefined,
      ),
    );
    return section;
  }
}

export function RunReport(run: IRun): HTMLElement {
  const section = element("section", "", "csRunReport");
  section.appendChild(element("h4", "Run report", "csSessionLogTitle"));
  const samples = run.samples ?? [];
  section.appendChild(
    detailColumns(
      detailGrid(runSummary(run)),
      samples.length ? usagePlots(run, samples, "peak") : undefined,
    ),
  );
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
