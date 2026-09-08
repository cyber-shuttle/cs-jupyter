import type { IMetricSample, IRun, IRunStats, IRuntime } from "./Common";

// A cumulative CPU counter says nothing on its own; the rate between two
// readings is the figure that means something, so a gap missing either reading
// is dropped rather than guessed.
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

// The busiest device in each sample: a card sitting idle beside a saturated one
// is not what an owner needs to see at a glance.
export const gpuUtilisation = (samples: readonly IMetricSample[]): number[] =>
  samples.flatMap((sample) =>
    sample.gpus?.length
      ? [Math.max(...sample.gpus.map((gpu) => gpu.utilPct))]
      : [],
  );

export interface IResourceGraph {
  label: string;
  values: number[];
  // The full height of the graph, so a series is read against what was
  // allocated rather than against its own maximum.
  ceiling: number;
  format: (value: number) => string;
}

export function resourceGraphs(
  allocation: Pick<IRuntime, "resources">,
  samples: readonly IMetricSample[],
): IResourceGraph[] {
  const { cores, memoryMb, gpuCount = 0 } = allocation.resources;
  const graphs: IResourceGraph[] = [
    {
      label: "CPU",
      values: cpuCoreSeries(samples),
      ceiling: cores,
      format: (value) => `${value.toFixed(1)} / ${cores} cores`,
    },
    {
      label: "Memory",
      values: memoryGigabytes(samples),
      ceiling: memoryMb / 1024,
      format: (value) =>
        `${value.toFixed(1)} / ${(memoryMb / 1024).toFixed(1)} GB`,
    },
  ];
  if (gpuCount > 0) {
    graphs.push({
      label: "GPU",
      values: gpuUtilisation(samples),
      ceiling: 100,
      format: (value) => `${Math.round(value)}%`,
    });
  }
  return graphs;
}

// values → SVG polyline points, newest last and the maximum at the top. slots
// fixes the x-grid to the window's capacity, so a filling window grows in from
// the left and then slides rather than restretching on every sample.
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
  ceiling: number,
  slots: number,
): string {
  const span = Math.max(ceiling, ...values, Number.EPSILON);
  const steps = Math.max(slots - 1, 1);
  const round = (value: number) => Math.round(value * 10) / 10;
  return values
    .map(
      (value, index) =>
        `${round((index * width) / steps)},${round(height - (value / span) * height)}`,
    )
    .join(" ");
}

// A finished run is described by whatever it left behind: Slurm's accounting
// when the flush landed, and the allocation's own last samples when it did not.
export function runSummary(run: IRun): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Ended", new Date(run.endedAt).toLocaleString()],
    ["Outcome", run.finalState],
    ["Ran for", elapsedLabel(run)],
  ];
  const stats: IRunStats = run.stats ?? {};
  if (stats.maxRss) rows.push(["Peak memory", stats.maxRss]);
  if (stats.requestedMemory) rows.push(["Requested", stats.requestedMemory]);
  if (stats.cpuEfficiencyPct !== undefined) {
    rows.push([
      "CPU used",
      `${Math.round(stats.cpuEfficiencyPct)}% of allocated`,
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

// The accounting figure when it landed, and the wall-clock span otherwise.
function elapsedLabel(run: IRun): string {
  const seconds =
    run.stats?.elapsedSeconds ??
    (run.startedAt
      ? Math.max(
          0,
          (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000,
        )
      : undefined);
  if (seconds === undefined) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// cs-control chases Slurm's accounting for ten minutes after a run ends and then
// leaves the record as it is.
const ACCOUNTING_WINDOW_MS = 10 * 60_000;

// Absent accounting means two different things. Just after a run ends the flush
// has not landed yet and is still coming; long after, it never arrived and never
// will, and saying it "will appear here" would be a promise nothing keeps.
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
