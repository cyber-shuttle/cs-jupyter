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
  it("emits the chosen resources as the session request", async () => {
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
      account: "project-a",
      partition: "gpu",
      resources: {
        cores: 2,
        memoryMb: 4096,
        wallMinutes: 60,
        gpuCount: 1,
        gpuType: "a100",
      },
    });
    widget.dispose();
  });

  it("preselects the Base application", () => {
    const widget = new CreateSessionForm(planeFake() as unknown as PlaneClient);
    widget.setClusters(
      [clusterFixture()],
      [
        deploymentFixture(),
        { ...deploymentFixture(), deploymentId: PROCESS_ID, name: "Base" },
      ],
    );
    const cluster = widget.node.querySelector<HTMLSelectElement>(
      'select[name="clusterId"]',
    )!;
    cluster.value = CLUSTER_ID;
    cluster.dispatchEvent(new Event("change"));
    expect(
      widget.node.querySelector<HTMLSelectElement>(
        'select[name="deploymentId"]',
      )!.value,
    ).toBe(PROCESS_ID);
    widget.dispose();
  });
});
