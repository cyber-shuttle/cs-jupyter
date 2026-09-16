// Turns discovered Slurm partitions into what the configuration step offers.
// It picks which resource types exist, which partitions match, and the GPU
// options a partition allows. MIN_CORES, MIN_MEMORY_MB and MAX_WALL_MINUTES
// mirror the bounds cs-control enforces in validateCreate.
import { IPartition } from "./Common";

export type ResourceType = "cpu" | "gpu";

export interface IPartitionChoice {
  key: string;
  partition: IPartition;
}

export const MIN_CORES = 2;
export const MIN_MEMORY_MB = 4096;
export const MAX_WALL_MINUTES = 525600;

function isGpuGres(item: { name: string }): boolean {
  return item.name === "gpu" || item.name.startsWith("gpu:");
}

function gpuType(name: string): { value: string; label: string } {
  if (name === "gpu") return { value: "gpu", label: "Generic GPU" };
  const stripped = name.replace(/^gpu:/, "");
  return { value: stripped, label: stripped };
}

function matchesType(partition: IPartition, type: ResourceType): boolean {
  const hasGpu = partition.gres.some(isGpuGres);
  return type === "gpu" ? hasGpu : !hasGpu;
}

export function partitionLabel(partition: IPartition): string {
  const hardware = partition.gres
    .filter(isGpuGres)
    .map((item) => `${item.count}× ${gpuType(item.name).label}`)
    .join(", ");
  return `${partition.name} — ${partition.cpuCount} CPU · ${partition.memoryMb} MB${
    hardware ? ` · ${hardware}` : ""
  }`;
}

export function partitionChoices(
  partitions: IPartition[],
  type: ResourceType,
): IPartitionChoice[] {
  return partitions
    .map((item, index) => ({ key: `${type}:${index}`, partition: item }))
    .filter(({ partition: item }) => matchesType(item, type));
}

export function availableResourceTypes(
  partitions: IPartition[],
): ResourceType[] {
  return (["cpu", "gpu"] as ResourceType[]).filter((type) =>
    partitions.some((item) => matchesType(item, type)),
  );
}

export function gpuOptions(
  partition: IPartition | undefined,
): Array<[string, string]> {
  return (partition?.gres.filter(isGpuGres) ?? []).map(
    (item): [string, string] => {
      const { value, label } = gpuType(item.name);
      return [value, label];
    },
  );
}

export function gpuMax(
  partition: IPartition | undefined,
  selectedGpuType: string,
): number {
  return (
    partition?.gres.find((item) => gpuType(item.name).value === selectedGpuType)
      ?.count ?? 1
  );
}
