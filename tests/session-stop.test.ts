// Start and stop actions on a session, the launch and connection to a
// Jupyter server through Linkspan. A start's busy state is driven by the
// click that started it, not the next poll. Stop from the post-create detail
// reaches its own confirmation even while Add Session is open; that
// confirmation once queued behind the wizard.
import { Dialog } from "@jupyterlab/apputils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import {
  acceptDialog,
  accessFixture,
  CLUSTER_ID,
  DEPLOYMENT_ID,
  planeFake,
  panelFake,
  pollPanel,
  processId,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const base = sessionFixture({ id: processId(1), state: "CREATED" });
const readyBase: ISession = { ...base, state: "READY" };

function card(panel: CyberShuttlePanel): HTMLElement {
  return panel.node.querySelector<HTMLElement>(".csSessionCard")!;
}

async function loaded(panel: CyberShuttlePanel): Promise<void> {
  await panel.restored;
  await vi.waitFor(() => expect(card(panel)).not.toBeNull());
}

async function started(startSession: unknown) {
  const api = planeFake({
    listSessions: vi.fn(async () => sessionListFixture([base])),
    startSession,
  });
  const panel = panelFake(api);
  await loaded(panel);
  return { panel, api };
}

describe("session stop action", () => {
  it("publishes busy state for the whole stop request", async () => {
    const stopPending = Promise.withResolvers<ISession>();
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi.fn(() => stopPending.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopping = panel.actions.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(base.id),
    );
    expect(panel.state.busySessionIds.has(base.id)).toBe(true);
    stopPending.resolve({ ...base, state: "CANCELLED" });
    await stopping;
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);
    panel.dispose();
  });

  it("stays submitted, busy and un-rearmed for the whole request", async () => {
    const pending = Promise.withResolvers<ISession>();
    const { panel, api } = await started(vi.fn(() => pending.promise));
    expect(card(panel).textContent).toContain("CREATED");

    const running = panel.actions.start(base.id);
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(base.id),
    );
    expect(card(panel).textContent).toContain("SUBMITTED");
    await pollPanel(panel);
    await pollPanel(panel);

    await panel.actions.start(base.id);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    pending.resolve({ ...base, state: "SUBMITTED" });
    await running;
    expect(card(panel).textContent).toContain("SUBMITTED");
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);
    panel.dispose();
  });

  it("keeps a failed start's reason on screen across a poll", async () => {
    const { panel } = await started(
      vi.fn(async () => {
        throw new Error("Slurm validation failed.");
      }),
    );
    await panel.actions.start(base.id);
    expect(panel.state.error).toBe("Slurm validation failed.");
    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm validation failed.");
    panel.dispose();
  });
  it("creates a session and launches it", async () => {
    const created = sessionFixture({ id: processId(9), state: "CREATED" });
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      createSession: vi.fn(async () => created),
      startSession: vi.fn(async () => ({
        ...created,
        state: "SUBMITTED" as const,
      })),
    });
    const panel = panelFake(api);
    await loaded(panel);
    const request = {
      slurmClusterConfigId: CLUSTER_ID,
      deploymentId: DEPLOYMENT_ID,
      batchJobConfig: { allocation: "project-a", wallTimeMinutes: 30 },
    };
    await panel.actions.create(request);
    expect(api.createSession).toHaveBeenCalledWith(request);
    expect(api.startSession).toHaveBeenCalledWith(created.id);
    expect(panel.state.sessions.map((each) => [each.id, each.state])).toEqual([
      [base.id, "CREATED"],
      [created.id, "SUBMITTED"],
    ]);
    panel.dispose();
  });

  it("keeps a failed stop's error across a poll whose access read succeeds", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi
        .fn()
        .mockRejectedValue(new Error("Slurm cancellation failed.")),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(base.id);
    await acceptDialog();
    await stopped;
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);

    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm cancellation failed.");
    panel.dispose();
  });

  it("keeps a connect's busy entry when a concurrent stop rejects afterward", async () => {
    const ready = sessionFixture({ id: processId(3), state: "READY" });
    const stopping = Promise.withResolvers<ISession>();
    const access = Promise.withResolvers<ReturnType<typeof accessFixture>>();
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([ready])),
      stopSession: vi.fn(() => stopping.promise),
      getSessionAccess: vi.fn(() => access.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(ready.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(ready.id),
    );
    expect(panel.state.busySessionIds.has(ready.id)).toBe(true);

    void panel.actions.connect(ready.id);
    await vi.waitFor(() => expect(api.getSessionAccess).toHaveBeenCalled());
    expect(panel.state.busySessionIds.has(ready.id)).toBe(true);

    stopping.reject(new Error("Slurm cancellation failed."));
    await stopped;

    expect(panel.state.busySessionIds.has(ready.id)).toBe(true);
    access.resolve(accessFixture(ready.id));
    panel.dispose();
  });
});

afterEach(() => {
  Dialog.flush();
});

describe("confirmations opened while the create wizard is open", () => {
  const base = sessionFixture({ id: processId(3), state: "READY" });
  const other = sessionFixture({ id: processId(4), state: "READY" });

  it("lets stop show its confirmation without the wizard being closed first", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      stopSession: vi.fn(async () => ({
        ...base,
        state: "CANCELLED" as const,
      })),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.sessions.map((each) => each.id)).toContain(base.id),
    );

    void panel.openCreate();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));

    void panel.actions.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(base.id),
    );

    panel.dispose();
  });

  it("keeps the second dialog rejectable after the first one closes", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture([base, other])),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() =>
      expect(panel.state.sessions.map((each) => each.id)).toEqual([
        base.id,
        other.id,
      ]),
    );

    void panel.modals.openSession(base.id);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));
    void panel.modals.openSession(other.id);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(2));

    const [first] = Dialog.tracker.filter(() => true);
    first.reject();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));

    (panel as any)._modals.rejectDetail();
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(0));

    panel.dispose();
  });
});
