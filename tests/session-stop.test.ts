// Stop, relaunch and delete actions on a session, the launch and connection to
// a Jupyter server through Linkspan. A relaunch's busy state is driven by the
// click that started it, not the next poll. cs-control can refuse a delete
// repeatedly, and each refusal must leave it pending for the next poll.
import { describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { ControlError } from "../src/ControlClient";
import { setActiveSessionId } from "../src/session-state";
import { displayState } from "../src/session-ui-state";
import {
  acceptDialog,
  accessFixture,
  controlFake,
  panelFake,
  pollPanel,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const base = sessionFixture({
  id: "s-111111111111",
  state: "STOPPED",
  account: "project-a",
  rootFolder: "projects/restart",
});

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

describe("session stop action", () => {
  it("publishes busy and error state for controller actions", async () => {
    const stopPending = Promise.withResolvers<ISession>();
    const failing = Promise.withResolvers<ISession>();
    const api = controlFake({
      listSessions: vi.fn(async () =>
        sessionListFixture([{ ...base, state: "READY" as const }]),
      ),
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

    const running = panel.actions.runAgain(base.id);
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(base.id),
    );
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

    const running = panel.actions.runAgain(base.id);
    await vi.waitFor(() =>
      expect(api.startSession).toHaveBeenCalledWith(base.id),
    );
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

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;
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
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      deleteSession,
    });
    const panel = panelFake(api);
    await loaded(panel);

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;
    expect(deleteSession).toHaveBeenCalledTimes(1);
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
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base, other])),
      deleteSession,
      getSessionAccess: vi.fn(async () =>
        accessFixture(other.id, other.generation),
      ),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;
    expect(deleteSession).toHaveBeenCalledTimes(1);

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
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      deleteSession,
      sshAuthWebSocket: vi.fn(() => vi.fn()),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;
    expect(deleteSession).toHaveBeenCalledTimes(1);

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
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      deleteSession,
    });
    const panel = panelFake(api);
    await loaded(panel);

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;
    expect(deleteSession).toHaveBeenCalledTimes(1);

    (panel as any)._error = "an unrelated standing error";

    await pollPanel(panel);
    await vi.waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
    expect(panel.state.error).toBe("an unrelated standing error");
    panel.dispose();
  });

  it("reports a failed stop's error on the session this page is attached to", async () => {
    const stopping = Promise.withResolvers<ISession>();
    const api = controlFake({
      listSessions: vi.fn(async () =>
        sessionListFixture([{ ...base, state: "READY" as const }]),
      ),
      stopSession: vi.fn(() => stopping.promise),
    });
    setActiveSessionId(base.id);
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(base.id);
    await acceptDialog();
    stopping.reject(new Error("Slurm cancellation failed."));
    await stopped;

    expect(panel.state.error).toBe("Slurm cancellation failed.");
    panel.dispose();
    setActiveSessionId(undefined);
  });

  it("keeps a failed stop's error across a poll whose access read succeeds", async () => {
    const stopping = Promise.withResolvers<ISession>();
    const ready = { ...base, state: "READY" as const };
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([ready])),
      stopSession: vi.fn(() => stopping.promise),
      getSessionAccess: vi.fn(async () =>
        accessFixture(ready.id, ready.generation),
      ),
    });
    const panel = panelFake(api);
    await loaded(panel);

    const stopped = panel.actions.stop(base.id);
    await acceptDialog();
    stopping.reject(new Error("Slurm cancellation failed."));
    await stopped;
    expect(panel.state.error).toBe("Slurm cancellation failed.");

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

    const removing = panel.actions.remove(base.id);
    await acceptDialog();
    await removing;

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
    access.resolve(accessFixture(ready.id, ready.generation));
    panel.dispose();
  });
});
