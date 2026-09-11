import type { IRuntime } from "./Common";

// Below this the countdown reads as a warning. cs-bridge warns at the same ten
// minutes, and one threshold serves every surface that shows the number here.
export const LOW_TIME_MS = 10 * 60_000;

// Slurm measures --time from the moment the allocation starts running, so
// before it starts the whole limit is still ahead of it -- which is what is
// actually left. After the deadline nothing is.
export function remainingMs(runtime: IRuntime, now: number): number {
  const limit = runtime.resources.wallMinutes * 60_000;
  const started = runtime.startedAt ? Date.parse(runtime.startedAt) : NaN;
  return Math.max(0, Number.isFinite(started) ? started + limit - now : limit);
}

// "1h 30m" above an hour, "0m 45s" below, so the figure never changes width
// faster than it changes meaning.
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

// A queued allocation is waiting under no deadline and a terminal one is over:
// only a started runtime is counting down. This is cs-control's own
// startedRuntime(), which is what makes its --time a deadline.
export const countsDown = (runtime: IRuntime): boolean =>
  runtime.state === "STARTING" || runtime.state === "READY";
