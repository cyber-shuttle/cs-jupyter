// Covers the metrics and usage math and the run-history view built on it. A
// cgroup CPU counter only climbs, so cores-busy comes from the rate between two
// readings. RunHistory must keep keyboard focus on an open disclosure across the
// sample poll that rebuilds it.
import { describe, expect, it } from "vitest";
import type { IMetricSample, IRun, ISession } from "../src/Common";
import { ControllerFake, runFixture, sessionFixture, uiState } from "./fakes";
import {
  accountingState,
  cpuCoreSeries,
  gpuUtilisation,
  memoryGigabytes,
  resourceGraphs,
  runSummary,
  sparklinePoints,
} from "../src/metrics";
import { RunHistory } from "../src/RunHistory";
import { usagePlots } from "../src/usage";

const sample = (
  seconds: number,
  over: Partial<IMetricSample> = {},
): IMetricSample => ({
  at: new Date(Date.UTC(2030, 0, 1, 0, 0, seconds)).toISOString(),
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
      gpuUtilisation([
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

  it("graphs a finished run's CPU against Slurm's allocated cores, not the request", () => {
    const graphs = resourceGraphs(
      {
        resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
        stats: { cores: 64 },
      },
      [sample(0)],
    );
    expect(graphs[0].ceiling).toBe(64);
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
  it("reports what Slurm's accounting said once it landed", () => {
    const rows = new Map(
      runSummary(
        runFixture({
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
    expect(rows.get("CPU used")).toBe("50% of requested");
    expect(rows.get("Outcome")).toBe("STOPPED");
  });

  it("labels Slurm's allocated cores distinctly from the requested cores", () => {
    const rows = new Map(
      runSummary(
        runFixture({
          resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
          stats: { cores: 64, elapsedSeconds: 60 },
        }),
      ),
    );
    expect(rows.get("Allocated cores")).toBe("64");
    expect(rows.has("Cores")).toBe(false);
  });

  it("falls back to the wall-clock span and claims no figures it lacks", () => {
    const rows = new Map(runSummary(runFixture()));
    expect(rows.get("Ran for")).toBe("1h 0m");
    expect(rows.has("Peak memory")).toBe(false);
    expect(rows.has("CPU used")).toBe(false);
  });
});

describe("accounting state", () => {
  const ran = (endedAt: string, stats?: IRun["stats"]): IRun =>
    ({ endedAt, stats }) as IRun;

  it("is pending only while the flush could still land", () => {
    const now = Date.parse("2030-01-01T01:00:00Z");
    expect(accountingState(ran("2030-01-01T00:59:00Z"), now)).toBe("pending");
    expect(accountingState(ran("2030-01-01T00:00:00Z"), now)).toBe("never");
    expect(
      accountingState(ran("2030-01-01T00:00:00Z", { maxRss: "1.0 GB" }), now),
    ).toBe("present");
  });
});

describe("usage plots", () => {
  const session = {
    id: "s-012345abcdef",
    resources: { cores: 8, memoryMb: 16384, wallMinutes: 60, gpuCount: 2 },
  } as never;
  const samples: IMetricSample[] = [
    { at: "2030-01-01T00:00:00Z", memBytes: 1024 ** 3, cpuUsageUsec: 0 },
    {
      at: "2030-01-01T00:00:05Z",
      memBytes: 2 * 1024 ** 3,
      cpuUsageUsec: 10_000_000,
    },
  ];

  it("stacks CPU, MEM and GPU in one row, each titled above its own plot", async () => {
    const row = usagePlots(session, samples, "latest");
    expect(
      [...row.querySelectorAll(".csUsageTitle")].map((n) => n.textContent),
    ).toEqual(["CPU", "MEM", "GPU"]);
    expect(row.querySelectorAll(".csPlot svg").length).toBe(3);
    expect(row.querySelector(".csPlot svg")?.getAttribute("viewBox")).toBe(
      "0 0 60 40",
    );
    expect(row.querySelectorAll(".csPlotLine").length).toBe(3);
  });

  it("calls out the latest reading live and the peak on a finished run", async () => {
    const live = usagePlots(session, samples, "latest");
    expect(live.textContent).toContain("2.0 / 16.0 GB");
    const done = usagePlots(session, samples, "peak");
    expect(done.textContent).toContain("peak 2.0 / 16.0 GB");
  });
});

describe("run history view", () => {
  const finished = runFixture({
    stats: { maxRss: "2.0 GB", elapsedSeconds: 3600 },
  });

  const live = sessionFixture({
    id: "s-999999999999",
    generation: "g-fedcba9876543210",
    sshHost: "deltaTest",
    resources: { cores: 4, memoryMb: 8192, wallMinutes: 120 },
    startedAt: "2030-01-01T00:00:00Z",
  });

  const panelWith = (runs: IRun[], sessions: ISession[]) =>
    new ControllerFake(uiState({ runs, sessions })) as never;

  it("lists finished runs with their report", async () => {
    const history = new RunHistory(panelWith([finished], []));
    expect(history.node.textContent).toContain("delta");
    expect(history.node.textContent).toContain("2.0 GB");
    expect(history.node.querySelector(".csRunReport")).not.toBeNull();
    history.dispose();
  });

  it("shows a session still going in its live state, not as stopped", async () => {
    const history = new RunHistory(panelWith([finished], [live]));
    const pills = [...history.node.querySelectorAll(".csSessionState")].map(
      (node) => node.textContent,
    );
    expect(pills).toEqual(["READY", "STOPPED"]);
    expect(history.node.textContent).toContain("Remaining");
    expect(history.node.textContent).not.toContain("not started yet");
    history.dispose();
  });

  it("does not list a terminal session as if it were still going", async () => {
    const stopped = { ...live, state: "STOPPED" } as ISession;
    const history = new RunHistory(panelWith([], [stopped]));
    expect(history.node.textContent).toContain("No runs yet.");
    history.dispose();
  });

  it("keeps focus on a disclosure across a state update", async () => {
    const controller = new ControllerFake(
      uiState({ runs: [finished], sessions: [live] }),
    ) as never;
    const history = new RunHistory(controller);
    document.body.appendChild(history.node);

    const summary = history.node.querySelector<HTMLElement>(
      "[data-session-action]",
    )!;
    summary.focus();
    expect(document.activeElement).toBe(summary);

    (controller as unknown as { setState(state: unknown): void }).setState(
      uiState({ runs: [finished], sessions: [live] }),
    );

    const restored = history.node.querySelector<HTMLElement>(
      "[data-session-action]",
    )!;
    expect(document.activeElement).toBe(restored);
    history.dispose();
    document.body.removeChild(history.node);
  });
});
