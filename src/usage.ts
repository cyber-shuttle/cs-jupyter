// CPU, MEM and GPU plots side by side, each under its own title. The live card
// and a finished run's report share the same three series, built here once.
// The slot count mirrors cs-control's window, so a filling series grows in
// from the left.
import type { IMetricSample, IRunStats, ISession } from "./Common";
import { element } from "./dom";
import {
  PLOT_HEIGHT,
  PLOT_WIDTH,
  resourceGraphs,
  sparklinePoints,
} from "./metrics";

const SLOTS = 20;

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
          Math.max(SLOTS, graph.values.length),
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
