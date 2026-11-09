// Covers the usage math and the run history view built on it. A
// cgroup CPU counter only climbs, so cores-busy comes from the rate between two
// readings. RunHistory must keep keyboard focus on an open disclosure across the
// sample poll that rebuilds it.
import { describe, expect, it } from "vitest";
import type { IUsageSample, ISession } from "../src/Common";
import {
  PanelStateFake,
  processId,
  runFixture,
  sessionFixture,
  uiState,
} from "./fakes";
import {
  cpuCoreSeries,
  gpuUsage,
  memoryGigabytes,
  resourceGraphs,
  runSummary,
  sparklinePoints,
  usagePlots,
} from "../src/usage";
import { RunHistory } from "../src/RunHistory";

const sample = (
  seconds: number,
  over: Partial<IUsageSample> = {},
): IUsageSample => ({
  at: Date.UTC(2030, 0, 1, 0, 0, seconds),
  ...over,
});

describe("resource samples", () => {
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
      gpuUsage([
        sample(0, {
          gpus: [{ utilPct: 12 }, { utilPct: 88 }],
        }),
      ]),
    ).toEqual([88]);
  });

  it("graphs each series against what the session was given", () => {
    const graphs = resourceGraphs(
      {
        resources: { cores: 8, memoryMb: 16384, wallMinutes: 60, gpuCount: 2 },
      },
      [sample(0, { memBytes: 1024 ** 3 })],
    );
    expect(graphs.map((graph) => [graph.label, graph.ceiling])).toEqual([
      ["CPU", 8],
      ["MEM", 16],
      ["GPU", 100],
    ]);
    expect(graphs[1].format(4)).toBe("4.0 / 16.0 GB");
  });

  it("leaves out the GPU graph for a session that asked for none", () => {
    const graphs = resourceGraphs(
      { resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 } },
      [sample(0)],
    );
    expect(graphs.map((graph) => graph.label)).toEqual(["CPU", "MEM"]);
  });
});

describe("sparkline", () => {
  it("places points on the window's grid with the maximum at the top", () => {
    expect(sparklinePoints([0, 5, 10], 10, 5)).toBe("0,40 15,20 30,0");
  });

  it("keeps a series that overshoots its ceiling inside the graph", () => {
    const points = sparklinePoints([20], 10, 1).split(",")[1];
    expect(Number(points)).toBe(0);
  });
});

describe("run report", () => {
  it("reports the outcome and the wall-clock span", () => {
    const rows = new Map(runSummary(runFixture()));
    expect(rows.get("Ran for")).toBe("1h 0m");
    expect(rows.get("Outcome")).toBe("CANCELLED");
  });
});

describe("usage plots", () => {
  const session = {
    resources: { cores: 8, memoryMb: 16384, wallMinutes: 60, gpuCount: 2 },
  } as never;
  const samples: IUsageSample[] = [
    sample(0, { memBytes: 1024 ** 3, cpuUsageUsec: 0 }),
    sample(5, { memBytes: 2 * 1024 ** 3, cpuUsageUsec: 10_000_000 }),
  ];

  it("stacks titled CPU, MEM and GPU plots, calling out the latest reading", async () => {
    const row = usagePlots(session, samples);
    expect(
      [...row.querySelectorAll(".csUsageTitle")].map((n) => n.textContent),
    ).toEqual(["CPU", "MEM", "GPU"]);
    expect(row.querySelectorAll(".csPlot svg").length).toBe(3);
    expect(row.querySelector(".csPlot svg")?.getAttribute("viewBox")).toBe(
      "0 0 60 40",
    );
    expect(row.querySelectorAll(".csPlotLine").length).toBe(3);
    expect(row.textContent).toContain("2.0 / 16.0 GB");
  });
});

describe("run history view", () => {
  const finished = runFixture();

  const live = sessionFixture({
    id: processId(2),
    resources: { cores: 4, memoryMb: 8192, wallMinutes: 120 },
    startedAt: "2030-01-01T00:00:00Z",
  });

  const panelWith = (runs: ISession[], sessions: ISession[]) =>
    new PanelStateFake(uiState({ runs, sessions })) as never;

  it("lists finished runs with their report, reading the opened one's detail", async () => {
    const panel = new PanelStateFake(uiState({ runs: [finished] }));
    const history = new RunHistory(panel as never, finished.id);
    expect(panel.logWatchers).toContainEqual(new Set([finished.id]));
    expect(history.node.textContent).toContain("hpc-a");
    expect(history.node.textContent).toContain("1h 0m");
    expect(history.node.querySelector("details")?.open).toBe(true);
    expect(history.node.querySelector(".csRunReport")).not.toBeNull();
    history.dispose();
  });

  it("shows a session still going in its live state, not as stopped", async () => {
    const history = new RunHistory(panelWith([finished], [live]));
    const pills = [...history.node.querySelectorAll(".csSessionState")].map(
      (node) => node.textContent,
    );
    expect(pills).toEqual(["RUNNING", "CANCELLED"]);
    expect(history.node.textContent).not.toContain("not started yet");
    history.dispose();
  });

  it("does not list a terminal session as if it were still going", async () => {
    const stopped = { ...live, state: "CANCELLED" } as ISession;
    const history = new RunHistory(panelWith([], [stopped]));
    expect(history.node.textContent).toContain("No runs yet.");
    history.dispose();
  });
});
