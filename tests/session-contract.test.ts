// Locks the cs-control wire shapes this client trusts against a checked-in
// fixture. An upstream field rename or removal is caught here, not rendered
// as undefined in the UI.
import { fakeAuth } from "./fakes";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../src/Common";
import { ControlClient, UNCHANGED } from "../src/ControlClient";
import providerFixture from "./fixtures/cs-control-session-contract.json";

const clientFor = (value: unknown) =>
  new ControlClient(
    "https://control.example.edu/api/v1",
    fakeAuth(),
    vi.fn<typeof globalThis.fetch>(async () => jsonResponse(value)),
  );

describe("checked narrow cs-control session JSON contract", () => {
  it("accepts only session state and rejects removed private/application fields", async () => {
    const list = await clientFor({
      sessions: [providerFixture],
      logs: [],
    }).listSessions();
    if (list === UNCHANGED) {
      throw new Error("cs-control answered 304 to a client with no list");
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

describe("checked narrow cs-control metric sample JSON contract", () => {
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

describe("checked narrow cs-control SSH host JSON contract", () => {
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

  it("rejects a non-boolean managed flag", async () => {
    await expect(
      clientFor({ hosts: [{ ...host, managed: "yes" }] }).listSshHosts(),
    ).rejects.toThrow("invalid SSH host");
  });
});

describe("checked narrow cs-control Slurm discovery JSON contract", () => {
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

  it("rejects a non-string account", async () => {
    await expect(
      clientFor({ ...discovery, accounts: [{}, 7] }).discoverSlurm("delta"),
    ).rejects.toThrow("invalid Slurm discovery");
  });

  it("rejects a gres entry with a non-string name", async () => {
    await expect(
      clientFor({
        ...discovery,
        partitions: [
          { ...discovery.partitions[0], gres: [{ name: 7, count: 4 }] },
        ],
      }).discoverSlurm("delta"),
    ).rejects.toThrow("invalid Slurm discovery");
  });

  it("rejects a non-string homeDir", async () => {
    await expect(
      clientFor({ ...discovery, homeDir: 7 }).discoverSlurm("delta"),
    ).rejects.toThrow("invalid Slurm discovery");
  });
});

describe("checked narrow cs-control run history JSON contract", () => {
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

  it("rejects a sample that is not an object", async () => {
    await expect(
      clientFor({
        runs: [{ ...run, samples: ["not a sample"] }],
      }).listRuns(),
    ).rejects.toThrow("invalid run history");
  });
});
