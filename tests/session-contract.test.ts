// How the client reads the CyberShuttle API's wire shapes into sessions, usage
// and Slurm discovery.
import {
  clientFor,
  CLUSTER_ID,
  processId,
  sessionFixture,
  sessionId,
} from "./fakes";
import { describe, expect, it } from "vitest";

describe("the CyberShuttle API session JSON contract", () => {
  it("lists every session as the CyberShuttle API returns it", async () => {
    const live = sessionFixture();
    const ended = sessionFixture(
      { sessionId: sessionId(1), state: "CANCELLED", live: false },
      { processId: processId(1), state: "CANCELLED" },
    );
    expect(await clientFor([live, ended]).listSessions()).toEqual([
      live,
      ended,
    ]);
  });
});

describe("the CyberShuttle API Slurm discovery JSON contract", () => {
  const discovery = {
    allocations: [{ account: "project-a", partitions: [], qos: [] }],
    partitions: [
      {
        name: "gpuA100",
        cpuPerNode: 64,
        maxMemory: 243200,
        gres: "gpu:a100:4,gpu:2",
      },
      { name: "small", cpuPerNode: null, maxMemory: null, gres: null },
    ],
  };

  it("reads a config's partitions and accounts", async () => {
    await expect(
      clientFor(discovery).discoverSlurm(CLUSTER_ID),
    ).resolves.toEqual({
      configId: CLUSTER_ID,
      accounts: ["project-a"],
      partitions: [
        {
          name: "gpuA100",
          cpuCount: 64,
          memoryMb: 243200,
          gres: [
            { name: "gpu:a100", count: 4 },
            { name: "gpu", count: 2 },
          ],
        },
        { name: "small", gres: [] },
      ],
    });
  });
});
