// Start and stop actions on a session, the launch and connection to a
// Jupyter server through Linkspan. A start's busy state is driven by the
// click that started it, not the next poll. Stop from the post-create detail
// reaches its own confirmation even while Add Session is open; that
// confirmation once queued behind the wizard.
import { Dialog } from "@jupyterlab/apputils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaneError, type ISession, type SessionState } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { SessionDetail } from "../src/SessionDetail";
import {
  acceptDialog,
  accessFixture,
  CLUSTER_ID,
  DEPLOYMENT_ID,
  logTail,
  planeFake,
  panelFake,
  pollPanel,
  processId,
  sessionFixture,
  sessionId,
} from "./fakes";

const numbered = (n: number, state: SessionState = "READY", live = true) =>
  sessionFixture(
    { sessionId: sessionId(n), state, live },
    { processId: processId(n) },
  );
const base = numbered(1, "CANCELLED", false);
const readyBase = numbered(1);
const request = {
  slurmClusterConfigId: CLUSTER_ID,
  deploymentId: DEPLOYMENT_ID,
  account: "project-a",
  resources: { cores: 2, memoryMb: 4096, wallMinutes: 30 },
};

function card(panel: CyberShuttlePanel): HTMLElement {
  return panel.node.querySelector<HTMLElement>(".csSessionCard")!;
}

async function loaded(panel: CyberShuttlePanel): Promise<void> {
  await panel.restored;
  await vi.waitFor(() => expect(card(panel)).not.toBeNull());
}

async function withEnded<T extends object>(overrides: T) {
  const api = planeFake({
    listSessions: vi.fn(async () => [base]),
    ...overrides,
  });
  const panel = panelFake(api);
  await loaded(panel);
  return { panel, api };
}

describe("session stop action", () => {
  it("publishes busy state for the whole stop request", async () => {
    const stopPending = Promise.withResolvers<ISession>();
    const api = planeFake({
      listSessions: vi.fn(async () => [readyBase]),
      stopSession: vi.fn(() => stopPending.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopping = panel.actions.stop(base.sessionId);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(readyBase),
    );
    expect(panel.state.busySessionIds.has(base.sessionId)).toBe(true);
    stopPending.resolve(numbered(1, "CANCELLED", false));
    await stopping;
    expect(panel.state.busySessionIds.has(base.sessionId)).toBe(false);
    panel.dispose();
  });

  it("stays busy and un-rearmed for the whole start request, showing the server's state", async () => {
    const pending = Promise.withResolvers<ISession>();
    const { panel, api } = await withEnded({
      startSession: vi.fn(() => pending.promise),
    });
    expect(card(panel).textContent).toContain("CANCELLED");

    const running = panel.actions.start(base.sessionId);
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(base.sessionId),
    );
    expect(card(panel).textContent).toContain("CANCELLED");
    expect(card(panel).textContent).not.toContain("SUBMITTED");
    expect(panel.state.busySessionIds.has(base.sessionId)).toBe(true);
    await pollPanel(panel);
    await pollPanel(panel);

    await panel.actions.start(base.sessionId);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    pending.resolve(numbered(1, "SUBMITTED"));
    await running;
    expect(card(panel).textContent).toContain("SUBMITTED");
    expect(panel.state.sessions.map((each) => each.sessionId)).toEqual([
      base.sessionId,
    ]);
    panel.dispose();
  });

  it("keeps a failed start's reason on screen across a poll", async () => {
    const { panel } = await withEnded({
      startSession: vi.fn(async () => {
        throw new Error("Slurm validation failed.");
      }),
    });
    await panel.actions.start(base.sessionId);
    expect(panel.state.error).toBe("Slurm validation failed.");
    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm validation failed.");
    panel.dispose();
  });

  it("deletes an ended session after confirming", async () => {
    const { panel, api } = await withEnded({
      deleteSession: vi.fn(async () => undefined),
    });
    const removing = panel.actions.remove(base.sessionId);
    await acceptDialog();
    await removing;
    expect(api.deleteSession).toHaveBeenCalledWith(base.sessionId);
    expect(panel.state.sessions.map((each) => each.sessionId)).not.toContain(
      base.sessionId,
    );
    panel.dispose();
  });

  it("keeps the session listed with the reason when a delete answers 409", async () => {
    const { panel } = await withEnded({
      deleteSession: vi.fn(async () => {
        throw new PlaneError("The session is live.", 409);
      }),
    });
    const removing = panel.actions.remove(base.sessionId);
    await acceptDialog();
    await removing;
    expect(panel.state.sessions.map((each) => each.sessionId)).toContain(
      base.sessionId,
    );
    expect(panel.state.error).toBe("The session is live.");
    panel.dispose();
  });

  it("creates a session with one request", async () => {
    const created = sessionFixture(
      { sessionId: sessionId(9), state: "SUBMITTED" },
      { processId: processId(9) },
    );
    const api = planeFake({
      listSessions: vi.fn(async () => [base]),
      createSession: vi.fn(async () => created),
      startSession: vi.fn(),
    });
    const panel = panelFake(api);
    await loaded(panel);
    await panel.actions.create(request);
    expect(api.createSession).toHaveBeenCalledWith(request);
    expect(api.startSession).not.toHaveBeenCalled();
    expect(
      panel.state.sessions.map((each) => [each.sessionId, each.state]),
    ).toEqual([
      [created.sessionId, "SUBMITTED"],
      [base.sessionId, "CANCELLED"],
    ]);
    panel.dispose();
  });

  it("shows a failed launch's reason on the session it created", async () => {
    const failed = sessionFixture(
      { state: "FAILED", live: false },
      { state: "FAILED", error: "The deployment has no template." },
    );
    const api = planeFake({
      listSessions: vi.fn(async () => [base]),
      createSession: vi.fn(async () => failed),
    });
    const panel = panelFake(api);
    await loaded(panel);
    await expect(panel.actions.create(request)).resolves.toMatchObject({
      live: false,
    });
    expect(panel.state.error).toBe("");
    expect(
      new SessionDetail(panel, failed.sessionId).node.textContent,
    ).toContain("The deployment has no template.");
    panel.dispose();
  });

  it("re-reads a stopped run's log once, so its report has the final statuses", async () => {
    const run = processId(1);
    const stopped = numbered(1, "CANCELLED", false);
    const api = planeFake({
      listSessions: vi.fn(async () => [readyBase]),
      stopSession: vi.fn(async () => stopped),
      getSessionLogs: vi.fn(async () =>
        logTail(run, [{ text: "running", at: "2026-01-01T00:00:00Z" }]),
      ),
    });
    const panel = panelFake(api);
    await loaded(panel);
    panel.logWatchers.add(new Set([run]));
    await pollPanel(panel);
    expect(panel.state.logs.has(run)).toBe(true);

    api.listSessions.mockResolvedValue([stopped]);
    api.getSessionLogs.mockResolvedValue(
      logTail(run, [{ text: "cancelled", at: "2026-01-01T00:00:01Z" }]),
    );
    const stopping = panel.actions.stop(readyBase.sessionId);
    await acceptDialog();
    await stopping;
    expect(panel.state.logs.has(run)).toBe(false);

    api.getSessionLogs.mockClear();
    await pollPanel(panel);
    await pollPanel(panel);
    expect(api.getSessionLogs.mock.calls).toEqual([[run]]);
    expect(panel.state.logs.get(run)?.lines.map((line) => line.text)).toEqual([
      "cancelled",
    ]);
    panel.dispose();
  });

  it("keeps a failed stop's error across a poll whose access read succeeds", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [readyBase]),
      stopSession: vi
        .fn()
        .mockRejectedValue(new Error("Slurm cancellation failed.")),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(base.sessionId);
    await acceptDialog();
    await stopped;
    expect(panel.state.busySessionIds.has(base.sessionId)).toBe(false);

    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm cancellation failed.");
    panel.dispose();
  });

  it("keeps a connect's busy entry when a concurrent stop rejects afterward", async () => {
    const ready = numbered(3);
    const stopping = Promise.withResolvers<ISession>();
    const access = Promise.withResolvers<ReturnType<typeof accessFixture>>();
    const api = planeFake({
      listSessions: vi.fn(async () => [ready]),
      stopSession: vi.fn(() => stopping.promise),
      getSessionAccess: vi.fn(() => access.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(ready.sessionId);
    await acceptDialog();
    await vi.waitFor(() => expect(api.stopSession).toHaveBeenCalledWith(ready));
    expect(panel.state.busySessionIds.has(ready.sessionId)).toBe(true);

    void panel.actions.connect(ready.sessionId);
    await vi.waitFor(() => expect(api.getSessionAccess).toHaveBeenCalled());
    expect(panel.state.busySessionIds.has(ready.sessionId)).toBe(true);

    stopping.reject(new Error("Slurm cancellation failed."));
    await stopped;

    expect(panel.state.busySessionIds.has(ready.sessionId)).toBe(true);
    access.resolve(accessFixture(ready.runs[0].processId));
    panel.dispose();
  });
});

afterEach(() => {
  Dialog.flush();
});

describe("confirmations opened while the create wizard is open", () => {
  const base = numbered(3);
  const other = numbered(4);

  it("lets stop show its confirmation without the wizard being closed first", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [base]),
      stopSession: vi.fn(async () => numbered(3, "CANCELLED", false)),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.sessions.map((each) => each.sessionId)).toContain(
        base.sessionId,
      ),
    );

    void panel.openCreate();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));

    void panel.actions.stop(base.sessionId);
    await acceptDialog();
    await vi.waitFor(() => expect(api.stopSession).toHaveBeenCalledWith(base));

    panel.dispose();
  });

  it("keeps the second dialog rejectable after the first one closes", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => [base, other]),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.sessions.map((each) => each.sessionId)).toEqual([
        base.sessionId,
        other.sessionId,
      ]),
    );

    void panel.modals.openSession(base.sessionId);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));
    void panel.modals.openSession(other.sessionId);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(2));

    const [first] = Dialog.tracker.filter(() => true);
    first.reject();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));

    (panel as any)._modals.rejectDetail();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(0));

    panel.dispose();
  });
});
