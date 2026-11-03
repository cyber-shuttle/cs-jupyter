import { describe, expect, it, vi } from "vitest";
import {
  clusterFixture,
  CLUSTER_ID,
  DEPLOYMENT_ID,
  deploymentFixture,
  planeFake,
  PROCESS_ID,
} from "./fakes";
import type { ISlurmInfo } from "../src/Common";
import { CreateSessionForm } from "../src/CreateSessionForm";
import type { PlaneClient } from "../src/PlaneClient";

const GPU_SLURM: ISlurmInfo = {
  configId: CLUSTER_ID,
  accounts: ["project-a"],
  partitions: [
    {
      name: "gpu",
      cpuCount: 8,
      memoryMb: 16384,
      gres: [{ name: "gpu:a100", count: 2 }],
    },
  ],
};

describe("Add Session form", () => {
  it("emits the chosen resources as the run's batch job config", async () => {
    const widget = new CreateSessionForm(
      planeFake({
        discoverSlurm: vi.fn(async () => GPU_SLURM),
      }) as unknown as PlaneClient,
    );
    document.body.appendChild(widget.node);
    widget.setClusters(
      [clusterFixture()],
      [
        deploymentFixture(),
        {
          ...deploymentFixture(),
          deploymentId: PROCESS_ID,
          slurmClusterId: "",
        },
      ],
    );
    const select = widget.node.querySelector<HTMLSelectElement>(
      'select[name="clusterId"]',
    )!;
    select.value = CLUSTER_ID;
    select.dispatchEvent(new Event("change"));
    const requested = vi.fn();
    widget.createRequested.connect((_sender, request) => requested(request));
    const create = await vi.waitFor(() => {
      const button = widget.node.querySelector<HTMLButtonElement>(
        "button[type=submit]",
      );
      if (!button || button.disabled) throw new Error("not ready");
      return button;
    });
    create.click();
    expect(requested).toHaveBeenCalledWith({
      slurmClusterConfigId: CLUSTER_ID,
      deploymentId: DEPLOYMENT_ID,
      batchJobConfig: {
        allocation: "project-a",
        partition: "gpu",
        cpus: 2,
        mem: "4096M",
        wallTimeMinutes: 60,
        gres: "gpu:a100:1",
      },
    });
    widget.dispose();
  });
});
