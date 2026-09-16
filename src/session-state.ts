// A session's identity in the URL is the sessionId and generation pair, or
// nothing. A session without a generation names no job.
import { GENERATION, SESSION_ID, validSessionId } from "./Common";

export function selectedSession(
  search = window.location.search,
): { sessionId: string; generation: string } | undefined {
  const query = new URLSearchParams(search);
  const sessionId = query.get("session")?.trim() ?? "";
  const generation = query.get("generation") ?? "";
  return SESSION_ID.test(sessionId) && GENERATION.test(generation)
    ? { sessionId, generation }
    : undefined;
}

export function sessionLiteUrl(
  sessionId: string,
  generation: string,
  documentPath?: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const id = validSessionId(sessionId);
  if (!GENERATION.test(generation))
    throw new Error("Invalid session generation.");
  const url = new URL(location.href);
  url.searchParams.set("session", id);
  url.searchParams.set("generation", generation);
  documentPath
    ? url.searchParams.set("path", documentPath)
    : url.searchParams.delete("path");
  return url.toString();
}

let activeSession: string | undefined;

export function setActiveSessionId(id: string | undefined): void {
  activeSession = id;
}

export function getActiveSessionId(): string | undefined {
  return activeSession;
}
