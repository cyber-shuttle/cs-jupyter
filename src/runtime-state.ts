let activeRuntime: string | undefined;

export function setActiveRuntimeId(id: string | undefined): void {
  activeRuntime = id;
}

export function getActiveRuntimeId(): string | undefined {
  return activeRuntime;
}
