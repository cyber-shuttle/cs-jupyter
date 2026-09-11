import type { IMetricSample, IRuntime } from "./Common";
import { element, plot } from "./dom";
import { resourceGraphs, sparklinePoints } from "./metrics";

// The window cs-control keeps, so a filling series grows in from the left and
// then slides rather than restretching on every sample.
const SLOTS = 20;

/**
 * CPU, MEM and GPU side by side, each a 3:2 plot under its own title. The live
 * card and a finished run's report show the same three series, so they are
 * built here once and differ only in which reading they call out.
 */
export function usagePlots(
  allocation: Pick<IRuntime, "resources">,
  samples: readonly IMetricSample[],
  reading: (values: number[]) => number | undefined,
  prefix = "",
): HTMLElement {
  const row = element("div", "", "csUsageRow");
  for (const graph of resourceGraphs(allocation, samples)) {
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
          60,
          40,
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

export const latest = (values: number[]): number | undefined =>
  values[values.length - 1];

export const peak = (values: number[]): number | undefined =>
  values.length ? Math.max(...values) : undefined;
