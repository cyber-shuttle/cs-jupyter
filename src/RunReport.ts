// What one finished session did: Slurm's accounting once it landed, and the
// session's own last samples otherwise. Both are laid out in the same two
// columns the live card uses. Logs are shown here because the card outlives
// its runs while a live tail ends with the run.
import type { IRun } from "./Common";
import { detailGrid, element, logSection } from "./dom";
import { accountingState, runSummary } from "./metrics";
import { usagePlots } from "./usage";

export function RunReport(run: IRun): HTMLElement {
  const section = element("section", "", "csRunReport");
  section.appendChild(element("h4", "Run report", "csSessionLogTitle"));
  const columns = element("div", "", "csDetailColumns");
  columns.appendChild(detailGrid(runSummary(run)));
  const samples = run.samples ?? [];
  if (samples.length) {
    columns.appendChild(usagePlots(run, samples, "peak"));
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
    section.appendChild(logSection(logs).section);
  }
  return section;
}
