import { describe, expect, it, vi } from "vitest";
import type { IMetricSample, IRun } from "../src/Common";
import type { ControlClient } from "../src/ControlClient";
import {
  cpuCoreSeries,
  gpuUtilisation,
  memoryGigabytes,
  resourceGraphs,
  runSummary,
  sparklinePoints,
} from "../src/metrics";

const sample = (
  seconds: number,
  over: Partial<IMetricSample> = {},
): IMetricSample => ({
  at: new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString(),
  ...over,
});

describe("resource samples", () => {
  // A cgroup CPU counter only ever climbs, so the rate between two readings is
  // the figure that means anything.
  it("differentiates the cumulative CPU counter into cores busy", () => {
    const series = cpuCoreSeries([
      sample(0, { cpuUsageUsec: 0 }),
      sample(5, { cpuUsageUsec: 10_000_000 }),
      sample(10, { cpuUsageUsec: 20_000_000 }),
    ]);
    expect(series).toEqual([2, 2]);
  });

  it("drops a gap that cannot be differentiated instead of guessing at it", () => {
    expect(
      cpuCoreSeries([
        sample(0, { cpuUsageUsec: 0 }),
        sample(5),
        sample(10, { cpuUsageUsec: 20_000_000 }),
      ]),
    ).toEqual([]);
    // Two readings at the same instant have no elapsed time to divide by.
    expect(
      cpuCoreSeries([
        sample(0, { cpuUsageUsec: 0 }),
        sample(0, { cpuUsageUsec: 5 }),
      ]),
    ).toEqual([]);
  });

  it("reads memory in gigabytes and a GPU by its busiest device", () => {
    expect(memoryGigabytes([sample(0, { memBytes: 2 * 1024 ** 3 })])).toEqual([
      2,
    ]);
    expect(
      gpuUtilisation([
        sample(0, {
          gpus: [
            { index: 0, utilPct: 12, memUsedMiB: 0, memTotalMiB: 40960 },
            { index: 1, utilPct: 88, memUsedMiB: 0, memTotalMiB: 40960 },
          ],
        }),
      ]),
      // An idle card beside a saturated one must not read as half busy.
    ).toEqual([88]);
  });

  // A series read on its own scale would make an idle allocation look busy.
  it("graphs each series against what the allocation was given", () => {
    const graphs = resourceGraphs(
      {
        resources: { cores: 8, memoryMb: 16384, wallMinutes: 60, gpuCount: 2 },
      },
      [sample(0, { memBytes: 1024 ** 3 })],
    );
    expect(graphs.map((graph) => [graph.label, graph.ceiling])).toEqual([
      ["CPU", 8],
      ["Memory", 16],
      ["GPU", 100],
    ]);
    expect(graphs[1].format(4)).toBe("4.0 / 16.0 GB");
  });

  it("leaves out the GPU graph for an allocation that asked for none", () => {
    const graphs = resourceGraphs(
      { resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 } },
      [sample(0)],
    );
    expect(graphs.map((graph) => graph.label)).toEqual(["CPU", "Memory"]);
  });
});

describe("sparkline", () => {
  // The x-grid is the window's capacity, so a filling window grows in from the
  // left and then slides rather than restretching on every sample.
  it("places points on the window's grid with the maximum at the top", () => {
    expect(sparklinePoints([0, 5, 10], 100, 24, 10, 5)).toBe("0,24 25,12 50,0");
  });

  it("keeps a series that overshoots its ceiling inside the graph", () => {
    const points = sparklinePoints([20], 100, 24, 10, 1).split(",")[1];
    expect(Number(points)).toBe(0);
  });

  it("says nothing for no samples", () => {
    expect(sparklinePoints([], 100, 24, 10, 20)).toBe("");
  });
});

describe("run report", () => {
  const run = (over: Partial<IRun> = {}): IRun =>
    ({
      runtimeId: "rt-012345abcdef",
      generation: "g-0123456789abcdef",
      sshHost: "delta",
      partition: "cpu",
      rootFolder: "$HOME/project",
      resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
      finalState: "STOPPED",
      startedAt: "2030-01-01T00:00:00Z",
      endedAt: "2030-01-01T01:00:00Z",
      ...over,
    }) as IRun;

  it("reports what Slurm's accounting said once it landed", () => {
    const rows = new Map(
      runSummary(
        run({
          stats: {
            elapsedSeconds: 5400,
            maxRss: "2.0 GB",
            requestedMemory: "4.0 GB",
            cpuEfficiencyPct: 49.6,
            memoryEfficiencyPct: 50,
          },
        }),
      ),
    );
    expect(rows.get("Ran for")).toBe("1h 30m");
    expect(rows.get("Peak memory")).toBe("2.0 GB");
    expect(rows.get("CPU used")).toBe("50% of allocated");
    expect(rows.get("Outcome")).toBe("STOPPED");
  });

  // The flush lands a beat after the job ends, so a run frozen without it still
  // knows how long it ran and must not invent the rest.
  it("falls back to the wall-clock span and claims no figures it lacks", () => {
    const rows = new Map(runSummary(run()));
    expect(rows.get("Ran for")).toBe("1h 0m");
    expect(rows.has("Peak memory")).toBe(false);
    expect(rows.has("CPU used")).toBe(false);
  });
});

describe("run history view", () => {
  it("lists finished runs newest first and shows each report", async () => {
    const { RunHistory } = await import("../src/RunHistory");
    const runs: IRun[] = [
      {
        runtimeId: "rt-012345abcdef",
        generation: "g-0123456789abcdef",
        sshHost: "delta",
        partition: "cpu",
        rootFolder: "$HOME/project",
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
        finalState: "STOPPED",
        startedAt: "2030-01-01T00:00:00Z",
        endedAt: "2030-01-01T01:00:00Z",
        stats: { maxRss: "2.0 GB", elapsedSeconds: 3600 },
      } as IRun,
    ];
    const history = new RunHistory({
      listRuns: vi.fn(async () => runs),
    } as unknown as ControlClient);
    await history.refresh();
    expect(history.node.textContent).toContain("delta");
    expect(history.node.textContent).toContain("2.0 GB");
    expect(history.node.querySelector(".csRunReport")).not.toBeNull();
    history.dispose();
  });

  it("says so plainly when nothing has finished", async () => {
    const { RunHistory } = await import("../src/RunHistory");
    const history = new RunHistory({
      listRuns: vi.fn(async () => []),
    } as unknown as ControlClient);
    await history.refresh();
    expect(history.node.textContent).toContain("No runs have finished yet.");
    history.dispose();
  });
});
