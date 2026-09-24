// Stop, relaunch and delete actions on a session, the launch and connection to
// a Jupyter server through Linkspan. A relaunch's busy state is driven by the
// click that started it, not the next poll. cs-plane can refuse a delete
// repeatedly, and each refusal must leave it pending for the next poll. Stop
// and Delete from the post-create detail reach their own confirmation even
// while Add Session is open; that confirmation once queued behind the wizard.
import { Dialog } from "@jupyterlab/apputils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { ControlError } from "../src/ControlClient";
import {
  acceptDialog,
  accessFixture,
  controlFake,
  panelFake,
  pollPanel,
  removeConfirmed,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const base = sessionFixture({
  id: "s-111111111111",
  state: "STOPPED",
  account: "project-a",
  rootFolder: "projects/restart",
});
const readyBase: ISession = { ...base, state: "READY" };

function card(panel: CyberShuttlePanel): HTMLElement {
  return panel.node.querySelector<HTMLElement>(".csSessionCard")!;
}

async function loaded(panel: CyberShuttlePanel): Promise<void> {
  await panel.signIn();
  await vi.waitFor(() => expect(card(panel)).not.toBeNull());
}

async function started(startSession: unknown) {
  const api = controlFake({
    listSessions: vi.fn(async () => sessionListFixture([base])),
    startSession,
  });
  const panel = panelFake(api);
  await loaded(panel);
  return { panel, api };
}

async function runAgainStarted(
  panel: CyberShuttlePanel,
  api: { startSession: unknown },
  id: string,
): Promise<{ running: Promise<void> }> {
  const running = panel.actions.runAgain(id);
  await vi.waitFor(() => expect(api.startSession).toHaveBeenCalledWith(id));
  return { running };
}

async function deletePanel<T extends object>(
  deleteSession: ReturnType<typeof vi.fn>,
  overrides: T = {} as T,
) {
  const api = controlFake({
    listSessions: vi.fn(async () => sessionListFixture([base])),
    deleteSession,
    ...overrides,
  });
  const panel = panelFake(api);
  await loaded(panel);
  await removeConfirmed(panel, base.id);
  expect(deleteSession).toHaveBeenCalledTimes(1);
  return { panel, api };
}

describe("session stop action", () => {
  it("publishes busy state for the whole stop request", async () => {
    const stopPending = Promise.withResolvers<ISession>();
    const api = controlFake({
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
    stopPending.resolve({ ...base, state: "STOPPING" });
    await stopping;
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);
    panel.dispose();
  });

  it("stays starting, busy and un-rearmed for the whole request", async () => {
    const pending = Promise.withResolvers<ISession>();
    const { panel, api } = await started(vi.fn(() => pending.promise));
    expect(card(panel).textContent).toContain("STOPPED");

    const { running } = await runAgainStarted(panel, api, base.id);
    expect(document.querySelector(".jp-Dialog")).toBeNull();
    await pollPanel(panel);
    await pollPanel(panel);

    await panel.actions.runAgain(base.id);
    expect(api.startSession).toHaveBeenCalledTimes(1);

    pending.resolve({ ...base, state: "QUEUED" });
    await running;
    expect(card(panel).textContent).toContain("QUEUED");
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);
    panel.dispose();
  });

  it("keeps a stopped session's own state while deleting it, not SUBMITTING", async () => {
    const pending = Promise.withResolvers<void>();
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      deleteSession: vi.fn(() => pending.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    void panel.actions.remove(base.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.deleteSession).toHaveBeenCalledWith(base.id),
    );

    expect(panel.state.busySessionIds.has(base.id)).toBe(true);
    expect(card(panel).textContent).toContain("STOPPED");
    expect(card(panel).textContent).not.toContain("SUBMITTING");

    pending.resolve();
    panel.dispose();
  });

  it("keeps a failed relaunch's reason on screen across a poll", async () => {
    const { panel } = await started(
      vi.fn(async () => {
        throw new Error("Slurm validation failed.");
      }),
    );
    await panel.actions.runAgain(base.id);
    expect(panel.state.error).toBe("Slurm validation failed.");
    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm validation failed.");
    panel.dispose();
  });

  it("stops a live session, keeps it visible, then deletes it once terminal", async () => {
    let state: ISession["state"] = "READY";
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([{ ...base, state }])),
      stopSession: vi.fn(async () => ({ ...base, state: "STOPPING" as const })),
      deleteSession: vi.fn(async () => undefined),
    });
    const panel = panelFake(api);
    await loaded(panel);

    await removeConfirmed(panel, base.id);
    expect(api.stopSession).toHaveBeenCalledOnce();
    expect(api.deleteSession).not.toHaveBeenCalled();
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);

    state = "STOPPING";
    await pollPanel(panel);
    expect(api.deleteSession).not.toHaveBeenCalled();

    state = "STOPPED";
    await pollPanel(panel);
    await vi.waitFor(() => expect(api.deleteSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(0));
    panel.dispose();
  });

  it("clears a pending delete when the terminal session is already gone", async () => {
    let state: ISession["state"] = "READY";
    const deleteSession = vi.fn(async () => {
      throw new ControlError("session_not_found", "session not found", 404);
    });
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([{ ...base, state }])),
      stopSession: vi.fn(async () => ({ ...base, state: "STOPPING" as const })),
      deleteSession,
    });
    const panel = panelFake(api);
    await loaded(panel);

    await removeConfirmed(panel, base.id);
    state = "STOPPED";
    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(0));

    await pollPanel(panel);
    expect(deleteSession).toHaveBeenCalledOnce();
    panel.dispose();
  });

  it("keeps retrying a delete cs-plane refuses more than once", async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockResolvedValueOnce(undefined);
    const { panel } = await deletePanel(deleteSession);
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);
    expect(panel.state.error).toBe("");

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);
    expect(panel.state.error).toBe("");

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(0));
    panel.dispose();
  });

  it("keeps a pending delete queued when a Connect on another card races its classification", async () => {
    const other = sessionFixture({ id: "s-222222222222", state: "READY" });
    const deleting = Promise.withResolvers<void>();
    const deleteSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockImplementationOnce(() => deleting.promise)
      .mockResolvedValueOnce(undefined);
    const { panel } = await deletePanel(deleteSession, {
      listSessions: vi.fn(async () => sessionListFixture([base, other])),
      getSessionAccess: vi.fn(async () => accessFixture(other.id, other.seq)),
    });

    const polling = pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));

    void panel.actions.connect(other.id);
    deleting.reject(
      new ControlError("session_not_stopped", "not released yet"),
    );
    await polling;

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(panel.state.sessions.map((each) => each.id)).toEqual([other.id]),
    );
    panel.dispose();
  });

  it("surfaces a permanent delete failure and abandons the pending intent", async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockRejectedValueOnce(
        new ControlError(
          "ssh_authentication_required",
          "SSH authentication is required",
        ),
      );
    const { panel, api } = await deletePanel(deleteSession, {
      sshAuthWebSocket: vi.fn(() => vi.fn()),
    });

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
    expect(api.sshAuthWebSocket).not.toHaveBeenCalled();
    expect(panel.state.error).toBe("SSH authentication is required");
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);

    await pollPanel(panel);
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect((panel as any)._polling).toBe(false);
    panel.dispose();
  });

  it("does not clear a standing error while retrying a pending delete", async () => {
    const deleteSession = vi.fn(async () => {
      throw new ControlError("session_not_stopped", "not released yet");
    });
    const { panel } = await deletePanel(deleteSession);

    (panel as any)._error = "an unrelated standing error";

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
    expect(panel.state.error).toBe("an unrelated standing error");
    panel.dispose();
  });

  it("keeps a failed stop's error across a poll whose access read succeeds", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi
        .fn()
        .mockRejectedValue(new Error("Slurm cancellation failed.")),
      getSessionAccess: vi.fn(async () =>
        accessFixture(readyBase.id, readyBase.seq),
      ),
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
    const ready = sessionFixture({ id: "s-333333333333", state: "READY" });
    const stopping = Promise.withResolvers<ISession>();
    const access = Promise.withResolvers<ReturnType<typeof accessFixture>>();
    const api = controlFake({
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
    access.resolve(accessFixture(ready.id, ready.seq));
    panel.dispose();
  });
});

afterEach(() => {
  Dialog.flush();
});

describe("confirmations opened while the create wizard is open", () => {
  const base = sessionFixture({ id: "s-333333333333", state: "READY" });
  const other = sessionFixture({ id: "s-444444444444", state: "READY" });

  it.each(["stop", "remove"] as const)(
    "lets %s show its confirmation without the wizard being closed first",
    async (action) => {
      const api = controlFake({
        listSessions: vi.fn(async () => sessionListFixture([base])),
        stopSession: vi.fn(async () => ({
          ...base,
          state: "STOPPING" as const,
        })),
      });
      const panel = panelFake(api);
      await panel.signIn();
      await vi.waitFor(() =>
        expect(panel.state.sessions.map((each) => each.id)).toContain(base.id),
      );

      void panel.openCreate();
      await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));

      void panel.actions[action](base.id);
      await acceptDialog();
      await vi.waitFor(() =>
        expect(api.stopSession).toHaveBeenCalledWith(base.id),
      );

      panel.dispose();
    },
  );

  it("keeps the second dialog rejectable after the first one closes", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base, other])),
    });
    const panel = panelFake(api);
    await panel.signIn();
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
