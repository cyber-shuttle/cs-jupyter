// Turns raw metric samples and run accounting into series and summaries the
// panel renders. A cumulative CPU counter is turned into a rate between
// consecutive readings. A finished run reports Slurm's accounting once it lands,
// or its own last samples otherwise.
import type { IMetricSample, IRun, IRunStats, ISession } from "./Common";
import { formatRemaining } from "./walltime";

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
  samples.flatMap((sample) =>
    sample.gpus?.length
      ? [Math.max(...sample.gpus.map((gpu) => gpu.utilPct))]
      : [],
  );

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

export const PLOT_WIDTH = 60;
export const PLOT_HEIGHT = 40;

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
