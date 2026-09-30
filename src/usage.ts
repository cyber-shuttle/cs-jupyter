// Turns raw usage samples and Slurm accounting into series, summaries,
// CPU/MEM/GPU usage plots (USAGE_SLOTS wide, mirroring cs-plane's window)
// and the status-bar walltime countdown for the session this page is
// attached to, drawn from the panel's state and hidden for a queued, stopping
// or finished session.
import type { IUsageSample, IRun, IRunStats, ISession } from "./Common";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import {
  CLOCK_GLYPH,
  countsDown,
  element,
  formatRemaining,
  remainingBadge,
} from "./dom";
import { PanelBoundWidget } from "./RebuildingWidget";
import { getActiveSessionId } from "./session";

export function cpuCoreSeries(samples: readonly IUsageSample[]): number[] {
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

export const memoryGigabytes = (samples: readonly IUsageSample[]): number[] =>
  samples.flatMap((sample) =>
    sample.memBytes === undefined ? [] : [sample.memBytes / 1024 ** 3],
  );

export const gpuUsage = (samples: readonly IUsageSample[]): number[] =>
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
  samples: readonly IUsageSample[],
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
      values: gpuUsage(samples),
      ceiling: 100,
      format: (value) => `${Math.round(value)}% busy`,
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
    rows.push(["Granted cores", String(stats.cores)]);
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
  samples: readonly IUsageSample[],
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

export class WalltimeStatus extends PanelBoundWidget {
  constructor(panel: CyberShuttlePanel) {
    super(panel);
    this.addClass("csWalltimeStatus");
    this._render();
  }

  private _session(): ISession | undefined {
    const session = this._state.sessions.find(
      (each) => each.id === getActiveSessionId(),
    );
    return session && countsDown(session) ? session : undefined;
  }

  protected _counting(): boolean {
    return this._session() !== undefined;
  }

  protected _rebuild(): void {
    const session = this._session();
    this.setHidden(!session);
    this.node.textContent = "";
    if (!session) {
      return;
    }
    const { label, low } = remainingBadge(session, Date.now());
    this.toggleClass("csWalltimeStatusLow", low);
    const caption = `${session.alias}: ${label} of the session's ${session.resources.wallMinutes} minutes left`;
    const item = element("span", "", "csWalltimeStatusItem");
    item.innerHTML = CLOCK_GLYPH;
    item.append(element("span", label));
    item.title = caption;
    this.node.appendChild(item);
  }
}
