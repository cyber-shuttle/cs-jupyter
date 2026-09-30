// Covers the panel's session-creation wizard and SSH host list against
// concurrent refresh and disposal. Opening and closing the wizard must not
// begin the panel's poll loop again.
import { Dialog } from "@jupyterlab/apputils";
import { StackedPanel } from "@lumino/widgets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateSessionForm } from "../src/CreateSessionForm";
import { SshHosts } from "../src/SshHosts";
import type { ISshHost } from "../src/Common";
import {
  planeFake,
  panelFake,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

const alpha: ISshHost = {
  alias: "alpha",
  hostname: "alpha.example",
  extraDirectives: [],
  managed: false,
};
const gamma: ISshHost = {
  alias: "gamma",
  hostname: "gamma.example",
  extraDirectives: [],
  managed: false,
};
const createRequest = {
  idempotencyKey: "create-one",
  alias: "alpha",
  account: "project-a",
  partition: "cpu",
  rootFolder: "projects/new",
  resources: { cores: 1, memoryMb: 1024, wallMinutes: 60 },
  tunnelModes: ["link" as const],
};

afterEach(() => {
  Dialog.flush();
});

function harness(initialHosts: ISshHost[] = [alpha]) {
  const api = {
    resumeSignIn: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => sessionListFixture()),
    listSshHosts: vi.fn(async (): Promise<ISshHost[]> => initialHosts),
    createSession: vi.fn(),
    startSession: vi.fn(async (id: string) =>
      sessionFixture({ id, state: "QUEUED" }),
    ),
    getDevTunnelsAccount: vi.fn(async () => ({ connected: false })),
  };
  const panel = panelFake(api);
  const forms: CreateSessionForm[] = [];
  const hostWidgets: SshHosts[] = [];
  const hostRenders: ReturnType<typeof vi.spyOn>[] = [];
  (panel as any)._modals._createForm = () => {
    const form = new CreateSessionForm(
      api as any,
      () => (panel as any)._modals.sshAuthDock,
    );
    forms.push(form);
    return form;
  };
  (panel as any)._modals._sshHostsWidget = () => {
    const widget = new SshHosts(api as any);
    hostWidgets.push(widget);
    hostRenders.push(vi.spyOn(widget as any, "_render"));
    return widget;
  };
  return {
    panel,
    api,
    forms,
    hostWidgets,
    hostRenders,
  };
}

describe("SSH host refresh while the session wizard is active", () => {
  it("uses fresh create modal widgets and swaps the same dialog to session detail", async () => {
    const state = harness();
    await vi.waitFor(() => expect(state.api.listSshHosts).toHaveBeenCalled());
    const pollTimer = (state.panel as any)._pollTimer;
    state.api.createSession.mockResolvedValue({
      id: "s-111111111111",
      seq: 1,
    });

    void state.panel.openCreate();
    await vi.waitFor(() => expect(state.forms).toHaveLength(1));
    const first = state.forms[0];
    expect([first.isHidden, first.isDisposed]).toEqual([false, false]);
    first.createRequested.emit(createRequest);
    await vi.waitFor(() =>
      expect(state.api.createSession).toHaveBeenCalledOnce(),
    );
    expect(state.api.startSession).toHaveBeenCalledWith("s-111111111111");
    await vi.waitFor(() =>
      expect(document.body.querySelector(".csSessionDetail")).not.toBeNull(),
    );
    expect([Dialog.tracker.size, first.isDisposed]).toEqual([1, false]);

    Dialog.flush();
    await vi.waitFor(() => expect(first.isDisposed).toBe(true));
    void state.panel.openCreate();
    await vi.waitFor(() => expect(state.forms).toHaveLength(2));
    expect(state.forms[1]).not.toBe(first);
    state.forms[1].createRequested.emit({
      ...createRequest,
      idempotencyKey: "create-two",
    });
    await vi.waitFor(() =>
      expect(state.api.createSession).toHaveBeenCalledTimes(2),
    );
    expect([
      state.forms[1].isDisposed,
      (state.panel as any)._pollTimer === pollTimer,
    ]).toEqual([false, true]);
    state.panel.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores deferred create %s after modal disposal",
    async (outcome) => {
      const state = harness();
      const completion = Promise.withResolvers<{
        id: string;
        seq: number;
      }>();
      state.api.createSession.mockReturnValueOnce(completion.promise);
      const form = new CreateSessionForm(
        state.api as any,
        () => (state.panel as any)._modals.sshAuthDock,
      );
      const body = new StackedPanel();
      body.addWidget(form);
      const show = vi.fn();
      const setError = vi.spyOn(form, "setError");
      const pending = (state.panel as any)._modals._createInDialog(
        createRequest,
        form,
        body,
        show,
      );
      const errors = setError.mock.calls.length;
      body.dispose();
      outcome === "resolve"
        ? completion.resolve({
            id: "s-111111111111",
            seq: 1,
          })
        : completion.reject(new Error("late failure"));
      await pending;
      expect([show.mock.calls.length, setError.mock.calls.length]).toEqual([
        0,
        errors,
      ]);
      state.panel.dispose();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a deferred SSH host refresh after %s",
    async (outcome) => {
      const state = harness();
      const listHosts = state.api.listSshHosts;
      await vi.waitFor(() => expect(listHosts).toHaveBeenCalled());
      const completion = Promise.withResolvers<ISshHost[]>();
      state.api.listSshHosts.mockReturnValueOnce(completion.promise);
      void state.panel.openSshHosts();
      await vi.waitFor(() => expect(listHosts).toHaveBeenCalledTimes(2));
      const host = state.hostWidgets[0];
      await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));
      Dialog.tracker.currentWidget!.reject();
      await vi.waitFor(() => expect(host.isDisposed).toBe(true));
      state.hostRenders[0].mockClear();
      outcome === "resolve"
        ? completion.resolve([gamma])
        : completion.reject(new Error("late"));
      await new Promise((done) => setTimeout(done));
      expect(state.hostRenders[0]).not.toHaveBeenCalled();
      state.panel.dispose();
    },
  );

  it("enables Add Session after adding an SSH host from inside the create wizard", async () => {
    const { panel, api, forms } = harness([]);
    await panel.restored;
    await vi.waitFor(() => expect(api.listSshHosts).toHaveBeenCalled());
    const addButton = (): HTMLButtonElement =>
      panel.node.querySelector<HTMLButtonElement>(
        '[aria-label="Add Session"]',
      )!;
    expect(addButton().disabled).toBe(true);

    void panel.openCreate();
    await vi.waitFor(() => expect(forms).toHaveLength(1));
    api.listSshHosts.mockResolvedValue([alpha]);
    forms[0].sshHostsRequested.emit(undefined);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));
    Dialog.tracker.currentWidget!.reject();
    await vi.waitFor(() => expect(addButton().disabled).toBe(false));
    panel.dispose();
  });

  it("does not let a stale SSH host list reach a signed-out panel", async () => {
    const gate = Promise.withResolvers<ISshHost[]>();
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture()),
      listSshHosts: vi.fn(() => gate.promise),
    });
    const panel = panelFake(api);
    await vi.waitFor(() => expect(api.listSshHosts).toHaveBeenCalled());
    panel.signOut();
    gate.resolve([alpha]);
    await new Promise((done) => setTimeout(done));
    expect((panel as any)._hosts).toBeUndefined();
    panel.dispose();
  });

  it("clears only the error _refreshHosts itself set, not a standing action error", async () => {
    const api = planeFake({
      listSessions: vi.fn(async () => sessionListFixture()),
      listSshHosts: vi.fn(async () => [alpha]),
    });
    const panel = panelFake(api);
    await panel.restored;
    await vi.waitFor(() => expect(api.listSshHosts).toHaveBeenCalled());
    (panel as any)._error = "Stop failed: session is busy.";
    await (panel as any)._refreshHosts();
    expect(panel.state.error).toBe("Stop failed: session is busy.");
    panel.dispose();
  });
});
