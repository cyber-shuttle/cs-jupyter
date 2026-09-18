// Stop, relaunch and delete actions on a session, the launch and connection to
// a Jupyter server through Linkspan. A relaunch's busy state is driven by the
// click that started it, not the next poll. cs-control can refuse a delete
// repeatedly, and each refusal must leave it pending for the next poll. Stop
// and Delete from the post-create detail reach their own confirmation even
// while Add Session is open; that confirmation once queued behind the wizard.
import { Dialog } from "@jupyterlab/apputils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { ControlError } from "../src/ControlClient";
import { setActiveSessionId } from "../src/session";
import { displayState } from "../src/session";
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

async function stopFailing(
  panel: CyberShuttlePanel,
  id: string,
  message: string,
  stopping: PromiseWithResolvers<ISession>,
): Promise<void> {
  const stopped = panel.actions.stop(id);
  await acceptDialog();
  stopping.reject(new Error(message));
  await stopped;
  expect(panel.state.error).toBe(message);
}

describe("session stop action", () => {
  it("publishes busy and error state for controller actions", async () => {
    const stopPending = Promise.withResolvers<ISession>();
    const failing = Promise.withResolvers<ISession>();
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi
        .fn()
        .mockReturnValueOnce(failing.promise)
        .mockReturnValueOnce(stopPending.promise),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const failingStop = panel.actions.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith(base.id),
    );
    expect(panel.state.busySessionIds.has(base.id)).toBe(true);
    failing.reject(new Error("Slurm cancellation failed."));
    await failingStop;
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);
    expect(panel.state.error).toBe("Slurm cancellation failed.");

    const stopping = panel.actions.stop(base.id);
    await acceptDialog();
    await vi.waitFor(() => expect(api.stopSession).toHaveBeenCalledTimes(2));
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

  it("keeps SUBMITTING for the whole relaunch, in step with busy", async () => {
    const pending = Promise.withResolvers<ISession>();
    const { panel, api } = await started(vi.fn(() => pending.promise));
    let sawBusyWithoutSubmitting = false;
    panel.stateChanged.connect((_sender, state) => {
      const busy = state.busySessionIds.has(base.id);
      const session = state.sessions.find((each) => each.id === base.id);
      const shown = session && displayState(session, state.busySessionIds);
      if (busy && shown !== "SUBMITTING") {
        sawBusyWithoutSubmitting = true;
      }
    });

    const { running } = await runAgainStarted(panel, api, base.id);
    expect(card(panel).textContent).toContain("SUBMITTING");

    pending.resolve({ ...base, state: "QUEUED" });
    await running;

    expect(sawBusyWithoutSubmitting).toBe(false);
    expect(panel.state.busySessionIds.has(base.id)).toBe(false);
    expect(card(panel).textContent).toContain("QUEUED");
    panel.dispose();
  });

  it("keeps a stopped session's own state while deleting it, not SUBMITTING", async () => {
    const pending = Promise.withResolvers<ISession>();
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

    pending.resolve({ ...base, state: "STOPPED" });
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

  it("keeps a delete that the scheduler has not released yet, and finishes it", async () => {
    let state: ISession["state"] = "READY";
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([{ ...base, state }])),
      deleteSession: vi.fn(async () => {
        if (state !== "STOPPED") {
          throw new ControlError(
            "session_not_stopped",
            "session is still stopping",
          );
        }
        return { ...base, state: "STOPPED" as const };
      }),
    });
    const panel = panelFake(api);
    await loaded(panel);

    await removeConfirmed(panel, base.id);
    expect(api.deleteSession).toHaveBeenCalledTimes(1);
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);

    await pollPanel(panel);
    expect(api.deleteSession).toHaveBeenCalledTimes(1);

    state = "STOPPED";
    await pollPanel(panel);
    await vi.waitFor(() => expect(api.deleteSession).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(panel.state.sessions).toHaveLength(0));
    panel.dispose();
  });

  it("keeps retrying a delete cs-control refuses more than once", async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockResolvedValueOnce({ ...base, state: "STOPPED" as const });
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
    const deleting = Promise.withResolvers<ISession>();
    const deleteSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("session_not_stopped", "not released yet"),
      )
      .mockImplementationOnce(() => deleting.promise)
      .mockResolvedValueOnce({ ...base, state: "STOPPED" as const });
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

  it("keeps a delete pending without prompting for login, and does not block the next poll", async () => {
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
    expect(panel.state.sessions.map((each) => each.id)).toEqual([base.id]);
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

  it("reports a failed stop's error on the session this page is attached to", async () => {
    const stopping = Promise.withResolvers<ISession>();
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi.fn(() => stopping.promise),
    });
    setActiveSessionId(base.id);
    const panel = panelFake(api);
    await loaded(panel);

    await stopFailing(panel, base.id, "Slurm cancellation failed.", stopping);
    panel.dispose();
    setActiveSessionId(undefined);
  });

  it("keeps a failed stop's error across a poll whose access read succeeds", async () => {
    const stopping = Promise.withResolvers<ISession>();
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([readyBase])),
      stopSession: vi.fn(() => stopping.promise),
      getSessionAccess: vi.fn(async () =>
        accessFixture(readyBase.id, readyBase.seq),
      ),
    });
    const panel = panelFake(api);
    await loaded(panel);

    await stopFailing(panel, base.id, "Slurm cancellation failed.", stopping);

    await pollPanel(panel);
    expect(panel.state.error).toBe("Slurm cancellation failed.");
    panel.dispose();
  });

  it("removes the session this page is attached to from the list once deleted", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      deleteSession: vi.fn(async () => ({
        ...base,
        state: "STOPPED" as const,
      })),
    });
    setActiveSessionId(base.id);
    const panel = panelFake(api);
    await loaded(panel);

    await removeConfirmed(panel, base.id);

    expect(panel.state.sessions).toHaveLength(0);
    panel.dispose();
    setActiveSessionId(undefined);
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

  it.each([
    ["stop", "stopSession"],
    ["remove", "deleteSession"],
  ] as const)(
    "lets %s show its confirmation without the wizard being closed first",
    async (action, method) => {
      const api = controlFake({
        listSessions: vi.fn(async () => ({ sessions: [base], logs: [] })),
        [method]: vi.fn(async () => {
          if (method === "stopSession") {
            return { ...base, state: "STOPPING" as const };
          }
          throw new ControlError("session_not_stopped", "still stopping");
        }),
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
      await vi.waitFor(() => expect(api[method]).toHaveBeenCalledWith(base.id));

      panel.dispose();
    },
  );

  it("keeps the second dialog rejectable after the first one closes", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => ({ sessions: [base, other], logs: [] })),
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
