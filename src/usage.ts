// Turns usage samples into series, summaries, CPU/MEM/GPU usage plots
// (USAGE_SLOTS wide) and the status-bar walltime countdown for the session
// this page is attached to, drawn from the panel's state and hidden for a
// queued or finished session.
import type { IUsageSample, ISession } from "./Common";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import {
  CLOCK_GLYPH,
  countsDown,
  element,
  formatRemaining,
  remainingBadge,
} from "./dom";
import { PanelBoundWidget } from "./RebuildingWidget";
import { getActiveSessionId, sessionTitle } from "./session";

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
    const elapsedUsec = (sample.at - previous.at) * 1000;
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
  spec: Pick<ISession, "resources">,
  samples: readonly IUsageSample[],
): IResourceGraph[] {
  const { cores = 0, memoryMb = 0, gpuCount = 0 } = spec.resources;
  const memoryGb = memoryMb / 1024;
  const of = (limit: number, figure: string) => (limit ? ` / ${figure}` : "");
  const graphs: IResourceGraph[] = [
    {
      label: "CPU",
      values: cpuCoreSeries(samples),
      ceiling: cores,
      format: (value) => `${value.toFixed(1)}${of(cores, String(cores))} cores`,
    },
    {
      label: "MEM",
      values: memoryGigabytes(samples),
      ceiling: memoryGb,
      format: (value) =>
        `${value.toFixed(1)}${of(memoryGb, memoryGb.toFixed(1))} GB`,
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
  const { cores, memoryMb } = session.resources;
  const rows: Array<[string, string | undefined]> = [
    ["Partition", session.partition],
    ["Cores", cores ? String(cores) : undefined],
    ["Memory", memoryMb ? `${memoryMb} MB` : undefined],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
}

export const when = (at: string | undefined): string =>
  at ? new Date(at).toLocaleString() : "—";

export function runSummary(run: ISession): Array<[string, string]> {
  return [
    ["Ended", when(run.updatedAt)],
    ["Outcome", run.state],
    ["Ran for", elapsedLabel(run)],
  ];
}

function elapsedLabel(run: ISession): string {
  return run.startedAt && run.updatedAt
    ? formatRemaining(
        Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.startedAt)),
      )
    : "—";
}

export const USAGE_SLOTS = 20;

function plot(points: string, title: string): HTMLElement {
  const holder = element("div", "", "csPlot");
  holder.innerHTML = `<svg viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" preserveAspectRatio="none" role="img"><title>${title}</title><path class="csPlotGrid" d="M0 10H60M0 20H60M0 30H60M15 0V40M30 0V40M45 0V40" /><rect class="csPlotFrame" x="0.5" y="0.5" width="59" height="39" /><polyline class="csPlotLine" points="${points}" /></svg>`;
  return holder;
}

export function usagePlots(
  spec: Pick<ISession, "resources">,
  samples: readonly IUsageSample[],
): HTMLElement {
  const row = element("div", "", "csUsageRow");
  for (const graph of resourceGraphs(spec, samples)) {
    const value = graph.values.at(-1);
    const caption = value === undefined ? "—" : graph.format(value);
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
    const caption = `${sessionTitle(this._state, session)}: ${label} of the session's ${session.resources.wallMinutes} minutes left`;
    const item = element("span", "", "csWalltimeStatusItem");
    item.innerHTML = CLOCK_GLYPH;
    item.append(element("span", label));
    item.title = caption;
    this.node.appendChild(item);
  }
}
