// How the client reads the CyberShuttle API's wire shapes into sessions, usage
// and Slurm discovery.
import {
  clientFor,
  clusterFixture,
  CLUSTER_ID,
  processFixture,
  processId,
  runFixture,
  sessionFixture,
  slurmClusterFixture,
} from "./fakes";
import { describe, expect, it } from "vitest";

const providerFixture = sessionFixture({
  startedAt: "2030-01-01T00:00:30.000Z",
});
const process = processFixture(providerFixture);
const withConfig = (config: object) => ({
  ...process,
  batchProcess: {
    ...process.batchProcess!,
    batchJobConfig: { ...process.batchProcess!.batchJobConfig!, ...config },
  },
});

describe("the CyberShuttle API session JSON contract", () => {
  it("splits live sessions from ended runs across every deployment", async () => {
    const ended = runFixture({ id: processId(1) });
    const other = sessionFixture({
      id: processId(2),
      deploymentId: processId(3),
    });
    const list = await clientFor([
      process,
      processFixture(ended),
      processFixture(other),
      { ...process, processId: processId(4), batchProcess: null },
    ]).listSessions();
    expect(list.sessions).toEqual([providerFixture, other]);
    expect(list.runs).toEqual([ended]);
  });

  it("reads GPUs and memory from the job's own figures, and a failed job's last log as its error", async () => {
    const failed = sessionFixture({ state: "FAILED", error: "sbatch refused" });
    const list = await clientFor([
      withConfig({ gpus: null, gres: "gpu:a100:2", mem: "8G" }),
      processFixture(failed),
    ]).listSessions();
    expect(list.sessions[0].resources).toMatchObject({
      memoryMb: 8192,
      gpuCount: 2,
    });
    expect(list.runs[0].error).toBe("sbatch refused");
  });
});

describe("the CyberShuttle API Slurm discovery JSON contract", () => {
  const discovery = {
    allocations: [{ account: "project-a", partitions: [], qos: [] }],
  };
  const partitions = [
    {
      partitionId: "p1",
      name: "gpuA100",
      cpuPerNode: 64,
      maxMemory: 243200,
      gres: "gpu:a100:4,gpu:2",
    },
    {
      partitionId: "p2",
      name: "small",
      cpuPerNode: null,
      maxMemory: null,
      gres: null,
    },
  ];

  it("reads a config's partitions and accounts", async () => {
    await expect(
      clientFor(discovery).discoverSlurm(
        clusterFixture({
          slurmCluster: { ...slurmClusterFixture(), partitions },
        }),
      ),
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
