// Turns raw metric samples and run accounting into series, summaries,
// CPU/MEM/GPU usage plots (USAGE_SLOTS wide, mirroring cs-plane's window)
// and the status-bar walltime countdown for the session this page is
// attached to. It reads cs-plane directly since the launcher panel is
// disposed once anything opens, and hides for a queued, stopping or
// finished session.
import type { JupyterFrontEndPlugin } from "@jupyterlab/application";
import { IStatusBar } from "@jupyterlab/statusbar";
import { Widget } from "@lumino/widgets";
import type { IMetricSample, IRun, IRunStats, ISession } from "./Common";
import { isTerminal } from "./Common";
import { ControlClient, IControlClient } from "./ControlClient";
import {
  Clock,
  CLOCK_GLYPH,
  countsDown,
  element,
  formatRemaining,
  remainingBadge,
  remainingMs,
} from "./dom";
import { RUN_REPORT_KEY, selectedSession, sessionHomeUrl } from "./session";

export function cpuCoreSeries(samples: readonly IMetricSample[]): number[] {
  return samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (
      !previous ||
      previous.cpuUsageUsec === undefined ||
      sample.cpuUsageUsec === undefined
    ) {
      return [];
    }
    const elapsedUsec =
      (Date.parse(sample.at) - Date.parse(previous.at)) * 1000;
    return elapsedUsec > 0
      ? [(sample.cpuUsageUsec - previous.cpuUsageUsec) / elapsedUsec]
      : [];
  });
}

export const memoryGigabytes = (samples: readonly IMetricSample[]): number[] =>
  samples.flatMap((sample) =>
    sample.memBytes === undefined ? [] : [sample.memBytes / 1024 ** 3],
  );

export const gpuUtilisation = (samples: readonly IMetricSample[]): number[] =>
  samples.flatMap((sample) => {
    const pcts = (sample.gpus ?? []).flatMap((gpu) =>
      gpu.utilPct === undefined ? [] : [gpu.utilPct],
    );
    return pcts.length ? [Math.max(...pcts)] : [];
  });

interface IResourceGraph {
  label: string;
  values: number[];
  ceiling: number;
  format: (value: number) => string;
}

export function resourceGraphs(
  spec: Pick<ISession, "resources"> & { stats?: IRunStats },
  samples: readonly IMetricSample[],
): IResourceGraph[] {
  const { cores, memoryMb, gpuCount = 0 } = spec.resources;
  const cpuCeiling = spec.stats?.cores ?? cores;
  const memoryGb = memoryMb / 1024;
  const graphs: IResourceGraph[] = [
    {
      label: "CPU",
      values: cpuCoreSeries(samples),
      ceiling: cpuCeiling,
      format: (value) => `${value.toFixed(1)} / ${cpuCeiling} cores`,
    },
    {
      label: "MEM",
      values: memoryGigabytes(samples),
      ceiling: memoryGb,
      format: (value) => `${value.toFixed(1)} / ${memoryGb.toFixed(1)} GB`,
    },
  ];
  if (gpuCount > 0) {
    graphs.push({
      label: "GPU",
      values: gpuUtilisation(samples),
      ceiling: 100,
      format: (value) => `${Math.round(value)}% util`,
    });
  }
  return graphs;
}

const PLOT_WIDTH = 60;
const PLOT_HEIGHT = 40;

export function sparklinePoints(
  values: number[],
  ceiling: number,
  slots: number,
): string {
  const span = Math.max(ceiling, ...values, Number.EPSILON);
  const steps = Math.max(slots - 1, 1);
  const round = (value: number) => Math.round(value * 10) / 10;
  return values
    .map(
      (value, index) =>
        `${round((index * PLOT_WIDTH) / steps)},${round(PLOT_HEIGHT - (value / span) * PLOT_HEIGHT)}`,
    )
    .join(" ");
}

export function sessionSummary(session: ISession): Array<[string, string]> {
  return [
    ["Partition", session.partition],
    ["Cores", String(session.resources.cores)],
    ["Memory", `${session.resources.memoryMb} MB`],
  ];
}

export function runSummary(run: IRun): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Ended", new Date(run.endedAt).toLocaleString()],
    ["Outcome", run.finalState],
    ["Ran for", elapsedLabel(run)],
  ];
  const stats: IRunStats = run.stats ?? {};
  if (stats.cores !== undefined)
    rows.push(["Allocated cores", String(stats.cores)]);
  if (stats.maxRss) rows.push(["Peak memory", stats.maxRss]);
  if (stats.requestedMemory) rows.push(["Requested", stats.requestedMemory]);
  if (stats.cpuEfficiencyPct !== undefined) {
    rows.push([
      "CPU used",
      `${Math.round(stats.cpuEfficiencyPct)}% of requested`,
    ]);
  }
  if (stats.memoryEfficiencyPct !== undefined) {
    rows.push([
      "Memory used",
      `${Math.round(stats.memoryEfficiencyPct)}% of requested`,
    ]);
  }
  return rows;
}

function elapsedLabel(run: IRun): string {
  const seconds =
    run.stats?.elapsedSeconds ??
    (run.startedAt
      ? Math.max(
          0,
          (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000,
        )
      : undefined);
  return seconds === undefined ? "—" : formatRemaining(seconds * 1000);
}

const ACCOUNTING_WINDOW_MS = 10 * 60_000;

export function accountingState(
  run: IRun,
  now: number,
): "present" | "pending" | "never" {
  if (run.stats) return "present";
  const ended = Date.parse(run.endedAt);
  return Number.isFinite(ended) && now - ended < ACCOUNTING_WINDOW_MS
    ? "pending"
    : "never";
}

const USAGE_SLOTS = 20;

function plot(points: string, title: string): HTMLElement {
  const holder = element("div", "", "csPlot");
  holder.innerHTML = `<svg viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" preserveAspectRatio="none" role="img"><title>${title}</title><path class="csPlotGrid" d="M0 10H60M0 20H60M0 30H60M15 0V40M30 0V40M45 0V40" /><rect class="csPlotFrame" x="0.5" y="0.5" width="59" height="39" /><polyline class="csPlotLine" points="${points}" /></svg>`;
  return holder;
}

export function usagePlots(
  spec: Pick<ISession, "resources"> & { stats?: IRunStats },
  samples: readonly IMetricSample[],
  mode: "latest" | "peak",
): HTMLElement {
  const prefix = mode === "peak" ? "peak " : "";
  const reading = mode === "peak" ? peak : latest;
  const row = element("div", "", "csUsageRow");
  for (const graph of resourceGraphs(spec, samples)) {
    const value = reading(graph.values);
    const caption =
      value === undefined ? "—" : `${prefix}${graph.format(value)}`;
    const cell = element(
      "figure",
      "",
      `csUsagePlot csUsagePlot-${graph.label}`,
    );
    cell.append(
      element("figcaption", graph.label, "csUsageTitle"),
      plot(
        sparklinePoints(
          graph.values,
          graph.ceiling,
          Math.max(USAGE_SLOTS, graph.values.length),
        ),
        `${graph.label}: ${caption}`,
      ),
      element("span", caption, "csUsageValue"),
    );
    row.appendChild(cell);
  }
  return row;
}

const latest = (values: number[]): number | undefined =>
  values[values.length - 1];

const peak = (values: number[]): number | undefined =>
  values.length ? Math.max(...values) : undefined;

const WALLTIME_REFRESH_MS = 30_000;

export class WalltimeStatus extends Widget {
  private _session: ISession | undefined;
  private _clock = new Clock(() => this._render());
  private _refresh: number | undefined;

  constructor(
    private _api: ControlClient,
    private _sessionId: string,
    private _leave = () => window.location.replace(sessionHomeUrl()),
  ) {
    super();
    this.addClass("csWalltimeStatus");
    this._render();
    void this._reload();
    this._refresh = window.setInterval(
      () => void this._reload(),
      WALLTIME_REFRESH_MS,
    );
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
      if (this.isDisposed) return;
      if (isTerminal(session.state) || remainingMs(session, Date.now()) === 0) {
        sessionStorage.setItem(RUN_REPORT_KEY, `${session.id}/${session.seq}`);
        this._leave();
        return;
      }
      this._session = session;
      this._render();
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
  requires: [IStatusBar, IControlClient],
  activate: (_app, statusBar: IStatusBar, api: ControlClient) => {
    const selected = selectedSession();
    if (!selected) {
      return;
    }
    statusBar.registerStatusItem("@cybershuttle/jupyter:walltime-status", {
      align: "right",
      rank: 100,
      item: new WalltimeStatus(api, selected.sessionId),
    });
  },
};
