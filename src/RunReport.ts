import type { IRun } from "./Common";
import { element, sparkline } from "./dom";
import {
  accountingState,
  resourceGraphs,
  runSummary,
  sparklinePoints,
} from "./metrics";

/**
 * What one finished allocation did: Slurm's accounting when the flush landed,
 * and the allocation's own last samples either way. The same view serves a card
 * whose run just ended and a run read back out of the history, because they are
 * the same record.
 */
export function RunReport(run: IRun): HTMLElement {
  const section = element("section", "", "csRunReport");
  section.appendChild(element("h4", "Run report", "csRuntimeLogTitle"));
  const grid = element("dl", "", "csRuntimeDetailGrid");
  for (const [label, value] of runSummary(run)) {
    grid.append(
      element("dt", label, "csRuntimeDetailLabel"),
      element("dd", value, "csRuntimeDetailValue"),
    );
  }
  section.appendChild(grid);
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
  const samples = run.samples ?? [];
  if (samples.length) {
    const graphs = element("div", "", "csRunReportGraphs");
    for (const graph of resourceGraphs(run, samples)) {
      const row = element("div", "", "csRuntimeUsageRow");
      const peak = graph.values.length ? Math.max(...graph.values) : undefined;
      row.append(
        element("span", graph.label, "csRuntimeUsageLabel"),
        sparkline(
          sparklinePoints(graph.values, 100, 24, graph.ceiling, samples.length),
        ),
        element(
          "span",
          peak === undefined ? "—" : `peak ${graph.format(peak)}`,
          "csRuntimeUsageValue",
        ),
      );
      graphs.appendChild(row);
    }
    section.appendChild(graphs);
  }
  if (run.error) {
    section.appendChild(element("div", run.error, "csError"));
  }
  return section;
}
