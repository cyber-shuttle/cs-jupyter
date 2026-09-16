// Run history keys a running session by its own generation. A relaunching card
// keeps displaying SUBMITTING before cs-control has responded, but the session
// it is relaunching is still on its old, already-finished generation.
import { describe, expect, it, vi } from "vitest";
import { RunHistory } from "../src/RunHistory";
import {
  controlFake,
  panelFake,
  runFixture,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

describe("Run history", () => {
  it("keeps distinct keys for a relaunching session and its finished run", async () => {
    const stopped = sessionFixture({ state: "STOPPED" });
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([stopped])),
      listRuns: vi.fn(async () => [
        runFixture({ sessionId: stopped.id, generation: stopped.generation }),
      ]),
      startSession: vi.fn(() => new Promise<never>(() => {})),
    });
    const panel = panelFake(api);
    await panel.signIn();
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(1));

    void panel.actions.runAgain(stopped.id);
    await vi.waitFor(() =>
      expect(panel.state.busySessionIds.has(stopped.id)).toBe(true),
    );

    const history = new RunHistory(panel);
    document.body.appendChild(history.node);
    const keys = [
      ...history.node.querySelectorAll<HTMLElement>(
        "summary[data-session-action]",
      ),
    ].map((node) => node.dataset.sessionAction);
    expect(keys).toEqual([`${stopped.id}/${stopped.generation}`]);
    expect(history.node.textContent).toContain("SUBMITTING");

    history.dispose();
    panel.dispose();
  });
});
