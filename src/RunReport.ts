import type { IRun } from "./Common";
import { element, logLine } from "./dom";
import { accountingState, runSummary } from "./metrics";
import { peak, usagePlots } from "./usage";

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
  // The same two columns the live card uses: what the run was, beside what it
  // did with it.
  const columns = element("div", "", "csDetailColumns");
  columns.appendChild(grid);
  const samples = run.samples ?? [];
  if (samples.length) {
    columns.appendChild(usagePlots(run, samples, peak, "peak "));
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
    // What the allocation said, kept with the run rather than with the card: the
    // live tail is dropped the moment a run ends, and a card outlives its runs.
    const log = element("section", "", "csRuntimeLog");
    log.appendChild(element("h4", "Status", "csRuntimeLogTitle"));
    const scroller = element("div", "", "csRuntimeLogScroll");
    scroller.role = "log";
    for (const line of logs) {
      scroller.appendChild(logLine(line));
    }
    log.appendChild(scroller);
    section.appendChild(log);
  }
  return section;
}
