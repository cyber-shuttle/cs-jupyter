// Covers the panel's session-creation wizard and SSH host list against
// concurrent refresh and disposal. Opening and closing the wizard must not
// restart the panel's poll loop. A stale cached credential can fail the first
// host read, but a later sign-in must re-read hosts.
import { Dialog } from "@jupyterlab/apputils";
import { StackedPanel } from "@lumino/widgets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateSessionForm } from "../src/CreateSessionForm";
import { SshHosts } from "../src/SshHosts";
import type { ISshHost } from "../src/Common";
import { controlFake, panelFake, sessionListFixture } from "./fakes";

const alpha: ISshHost = {
  name: "alpha",
  hostname: "alpha.example",
  extraDirectives: [],
};
const gamma: ISshHost = {
  name: "gamma",
  hostname: "gamma.example",
  extraDirectives: [],
};
const createRequest = {
  idempotencyKey: "create-one",
  sshHost: "alpha",
  account: "project-a",
  partition: "cpu",
  rootFolder: "projects/new",
  resources: { cores: 1, memoryMb: 1024, wallMinutes: 60 },
};

afterEach(() => {
  Dialog.flush();
});

function harness(initialHosts: ISshHost[] = [alpha]) {
  const api = {
    signIn: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => sessionListFixture()),
    listSshHosts: vi.fn(async (): Promise<ISshHost[]> => initialHosts),
    createSession: vi.fn(),
  };
  const panel = panelFake(api);
  void panel.signIn();
  const forms: CreateSessionForm[] = [];
  const hostWidgets: SshHosts[] = [];
  const hostRenders: ReturnType<typeof vi.spyOn>[] = [];
  (panel as any)._modals._createForm = () => {
    const form = new CreateSessionForm(api as any);
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

describe("host refresh while the session wizard is active", () => {
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
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Waiting for live session state…",
      ),
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
      const form = new CreateSessionForm(state.api as any);
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

  it("enables Add Session after adding a host from inside the create wizard", async () => {
    const { panel, api, forms } = harness([]);
    await panel.signIn();
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

  it("re-reads hosts when the first activation could not", async () => {
    let fail = true;
    const api = {
      signIn: vi.fn(async () => undefined),
      resumeSignIn: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => sessionListFixture()),
      listSshHosts: vi.fn(async () => {
        if (fail) {
          throw new Error("cs-control returned 401");
        }
        return [alpha];
      }),
    };
    const panel = panelFake(api);

    await panel.resume();
    await vi.waitFor(() => expect(api.listSshHosts).toHaveBeenCalled());
    expect(panel.state.error).toContain("401");
    const afterResume = api.listSshHosts.mock.calls.length;

    fail = false;
    await panel.signIn();
    await vi.waitFor(() =>
      expect(api.listSshHosts.mock.calls.length).toBeGreaterThan(afterResume),
    );
    await vi.waitFor(() => expect(panel.state.error).toBe(""));
    panel.dispose();
  });

  it("does not let a stale host list from a signed-out session reach the next one", async () => {
    const gate = Promise.withResolvers<ISshHost[]>();
    let calls = 0;
    const api = controlFake({
      resumeSignIn: vi.fn(async () => {
        throw new Error("no stored credentials");
      }),
      listSessions: vi.fn(async () => sessionListFixture()),
      listSshHosts: vi.fn(() => {
        calls++;
        return calls === 1 ? gate.promise : Promise.resolve([gamma]);
      }),
    });
    const panel = panelFake(api);
    void panel.signIn();
    await vi.waitFor(() => expect(calls).toBe(1));
    panel.signOut();
    gate.resolve([alpha]);
    await new Promise((done) => setTimeout(done));
    await panel.signIn();
    await vi.waitFor(() => expect((panel as any)._hosts).toEqual([gamma]));
    panel.dispose();
  });

  it("clears only the error _refreshHosts itself set, not a standing action error", async () => {
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture()),
      listSshHosts: vi.fn(async () => [alpha]),
    });
    const panel = panelFake(api);
    await panel.signIn();
    await vi.waitFor(() => expect(api.listSshHosts).toHaveBeenCalled());
    (panel as any)._error = "Stop failed: session is busy.";
    await (panel as any)._refreshHosts();
    expect(panel.state.error).toBe("Stop failed: session is busy.");
    panel.dispose();
  });
});
