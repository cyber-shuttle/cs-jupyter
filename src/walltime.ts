// Session walltime countdown math shared by the status bar and session cards.
// Slurm measures --time from when a job starts running, so the full limit
// shows until then. The formatted figure switches from hours and minutes to
// minutes and seconds at the one-hour mark.
import type { ISession } from "./Common";

export const LOW_TIME_MS = 10 * 60_000;

export function remainingMs(session: ISession, now: number): number {
  const limit = session.resources.wallMinutes * 60_000;
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  return Math.max(0, Number.isFinite(started) ? started + limit - now : limit);
}

export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export const countsDown = (session: ISession): boolean =>
  session.state === "STARTING" || session.state === "READY";

export function remainingBadge(
  session: ISession,
  now: number,
): { label: string; low: boolean } {
  const left = remainingMs(session, now);
  return { label: formatRemaining(left), low: left <= LOW_TIME_MS };
}
