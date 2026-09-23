// Locks the cs-plane wire shapes this client trusts. An upstream field
// rename or removal is caught here, not rendered as undefined in the UI.
import { clientFor, sessionFixture } from "./fakes";
import { describe, expect, it } from "vitest";
import { UNCHANGED } from "../src/ControlClient";

const providerFixture = sessionFixture({
  account: "project-a",
  startedAt: "2030-01-01T00:00:30Z",
});

describe("checked narrow cs-plane session JSON contract", () => {
  it("rejects unknown fields and non-canonical state values", async () => {
    const list = await clientFor({
      sessions: [providerFixture],
      logs: [],
    }).listSessions();
    if (list === UNCHANGED) {
      throw new Error("cs-plane answered 304 to a client with no list");
    }
    expect(list.sessions[0]).toEqual(providerFixture);
    await expect(
      clientFor({
        sessions: [{ ...providerFixture, owner: {} }],
        logs: [],
      }).listSessions(),
    ).rejects.toThrow("invalid session");
    await expect(
      clientFor({
        sessions: [{ ...providerFixture, state: "ready" }],
        logs: [],
      }).listSessions(),
    ).rejects.toThrow("invalid session");
  });

  it.each([
    ["cores", { cores: 1, memoryMb: 4096, wallMinutes: 60 }],
    ["memory", { cores: 2, memoryMb: 4095, wallMinutes: 60 }],
    ["walltime", { cores: 2, memoryMb: 4096, wallMinutes: 0 }],
    ["GPU count", { cores: 2, memoryMb: 4096, wallMinutes: 60, gpuCount: 0 }],
  ])(
    "rejects session resources below the %s minimum",
    async (_name, resources) => {
      await expect(
        clientFor({
          sessions: [{ ...providerFixture, resources }],
          logs: [],
        }).listSessions(),
      ).rejects.toThrow("invalid session list");
    },
  );

  it("rejects a session missing required fields rather than rendering them undefined", async () => {
    for (const field of [
      "id",
      "seq",
      "sshHost",
      "partition",
      "rootFolder",
      "createdAt",
      "updatedAt",
    ] as const) {
      const { [field]: _omit, ...incomplete } = providerFixture;
      await expect(
        clientFor({ sessions: [incomplete], logs: [] }).listSessions(),
      ).rejects.toThrow("invalid session");
    }
  });
});

describe("checked narrow cs-plane metric sample JSON contract", () => {
  const at = "2026-01-01T00:00:00Z";

  it.each([
    ["a string memBytes", { at, memBytes: "1024" }],
    ["a string cpuUsageUsec", { at, cpuUsageUsec: "1000" }],
    ["a string GPU utilPct", { at, gpus: [{ index: 0, utilPct: "50" }] }],
  ])("rejects %s", async (_name, sample) => {
    await expect(
      clientFor({
        sessionId: providerFixture.id,
        samples: [sample],
      }).getSessionMetrics(providerFixture.id),
    ).rejects.toThrow("invalid metric series");
  });

  it("accepts numeric memory, CPU and GPU readings", async () => {
    const series = await clientFor({
      sessionId: providerFixture.id,
      samples: [
        {
          at,
          memBytes: 1024,
          cpuUsageUsec: 1000,
          gpus: [{ index: 0, utilPct: 50 }],
        },
      ],
    }).getSessionMetrics(providerFixture.id);
    expect(series.samples).toHaveLength(1);
  });
});

describe("checked narrow cs-plane SSH host JSON contract", () => {
  const host = { name: "delta", extraDirectives: [], managed: true };

  it("accepts a well-formed host", async () => {
    await expect(clientFor({ hosts: [host] }).listSshHosts()).resolves.toEqual([
      host,
    ]);
  });

  it("rejects a non-string extra directive", async () => {
    await expect(
      clientFor({
        hosts: [{ ...host, extraDirectives: [{ ProxyJump: "b" }] }],
      }).listSshHosts(),
    ).rejects.toThrow("invalid SSH host");
  });
});

describe("checked narrow cs-plane Slurm discovery JSON contract", () => {
  const discovery = {
    host: "delta",
    accounts: ["project-a"],
    partitions: [
      {
        name: "gpuA100",
        cpuCount: 64,
        memoryMb: 243200,
        gres: [{ name: "gpu:a100", count: 4 }],
      },
    ],
  };

  it("accepts a well-formed discovery", async () => {
    await expect(clientFor(discovery).discoverSlurm("delta")).resolves.toEqual(
      discovery,
    );
  });

  it("rejects a missing host", async () => {
    const { host: _omit, ...incomplete } = discovery;
    await expect(clientFor(incomplete).discoverSlurm("delta")).rejects.toThrow(
      "invalid Slurm discovery",
    );
  });
});

describe("checked narrow cs-plane run history JSON contract", () => {
  const run = {
    sessionId: providerFixture.id,
    seq: providerFixture.seq,
    sshHost: "delta",
    partition: "cpu",
    rootFolder: "$HOME/project",
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 },
    finalState: "STOPPED",
    startedAt: "2030-01-01T00:00:30Z",
    endedAt: "2030-01-01T01:00:30Z",
  };

  it("accepts a well-formed run", async () => {
    await expect(clientFor({ runs: [run] }).listRuns()).resolves.toEqual([run]);
  });

  it("rejects a finalState outside the known session states", async () => {
    await expect(
      clientFor({ runs: [{ ...run, finalState: "BANANA" }] }).listRuns(),
    ).rejects.toThrow("invalid run");
  });
});
