// Stopping or deleting from the post-create detail must reach its own
// confirmation, even while Add Session is open. This regression-tests a bug
// where the confirmation queued invisibly behind the wizard.
import { Dialog } from "@jupyterlab/apputils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlError } from "../src/ControlClient";
import { acceptDialog, controlFake, panelFake, sessionFixture } from "./fakes";

const base = sessionFixture({ id: "s-333333333333", state: "READY" });
const other = sessionFixture({ id: "s-444444444444", state: "READY" });

afterEach(() => {
  Dialog.flush();
});

describe("confirmations opened while the create wizard is open", () => {
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
});

describe("two detail dialogs open at once", () => {
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
