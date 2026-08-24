import { Dialog } from "@jupyterlab/apputils";
import { StackedPanel } from "@lumino/widgets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { CreateRuntimeForm } from "../src/CreateRuntimeForm";
import { SshHosts } from "../src/SshHosts";
import type { ISshHost } from "../src/Common";
import { FakeOperation, runtimeListFixture } from "./fakes";

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
  account: "allocation",
  partition: "cpu",
  rootFolder: "projects/new",
  resources: { cores: 1, memoryMb: 1024, wallMinutes: 60 },
};

afterEach(() => {
  Dialog.flush();
});

function harness() {
  let hosts: ISshHost[] = [alpha];
  let hostError: Error | undefined;
  const api = {
    signIn: vi.fn(async () => undefined),
    listRuntimes: vi.fn(async () => runtimeListFixture()),
    listSshHosts: vi.fn(async () => {
      if (hostError) {
        throw hostError;
      }
      return hosts;
    }),
    runtimeStreamUrl: vi.fn(() => "/api/v1/runtimes/stream"),
    slurmStreamWebSocket: vi.fn((_host: string) => vi.fn()),
    sshAuthWebSocket: vi.fn((_host: string) => vi.fn()),
    createRuntime: vi.fn(),
  };
  const panel = new CyberShuttlePanel(api as any, { select: vi.fn() } as any);
  void panel.signIn();
  const operation = new FakeOperation();
  const forms: CreateRuntimeForm[] = [];
  const hostWidgets: SshHosts[] = [];
  const hostRenders: ReturnType<typeof vi.spyOn>[] = [];
  (panel as any)._createForm = () => {
    const form = new CreateRuntimeForm(api as any, () => operation);
    forms.push(form);
    return form;
  };
  (panel as any)._sshHostsWidget = () => {
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
    operation,
    failHosts(message = "temporary host refresh failure") {
      hostError = new Error(message);
    },
    succeedHosts(next: ISshHost[]) {
      hosts = next;
      hostError = undefined;
    },
  };
}

async function openWizard(
  panel: CyberShuttlePanel,
  forms: CreateRuntimeForm[],
): Promise<CreateRuntimeForm> {
  await vi.waitFor(() => {
    const create = panel.node.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Runtime"]',
    );
    expect(create?.disabled).toBe(false);
  });
  void panel.openCreate();
  await vi.waitFor(() => expect(forms).toHaveLength(1));
  const form = forms[0];
  form.node
    .querySelector<HTMLButtonElement>(
      'button[aria-label="Select runtime host alpha"]',
    )!
    .click();
  return form;
}

describe("host refresh while the runtime wizard is active", () => {
  it("uses fresh create modal widgets and swaps the same dialog to runtime detail", async () => {
    const state = harness();
    await vi.waitFor(() => expect(state.api.listSshHosts).toHaveBeenCalled());
    const pollTimer = (state.panel as any)._pollTimer;
    state.api.createRuntime.mockResolvedValue({
      id: "rt-111111111111",
      generation: "g-0123456789abcdef",
    });

    void state.panel.openCreate();
    await vi.waitFor(() => expect(state.forms).toHaveLength(1));
    const first = state.forms[0];
    expect([first.isHidden, first.isDisposed]).toEqual([false, false]);
    first.createRequested.emit(createRequest);
    await vi.waitFor(() =>
      expect(state.api.createRuntime).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Waiting for live runtime state…",
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
      expect(state.api.createRuntime).toHaveBeenCalledTimes(2),
    );
    // Opening and closing the wizard must not restart the poll loop.
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
        generation: string;
      }>();
      state.api.createRuntime.mockReturnValueOnce(completion.promise);
      const form = new CreateRuntimeForm(state.api as any);
      const body = new StackedPanel();
      body.addWidget(form);
      const reset = vi.spyOn(form, "resetRequestIdentity");
      const setError = vi.spyOn(form, "setError");
      const pending = (state.panel as any)._createInModal(
        createRequest,
        form,
        body,
        vi.fn(),
      );
      const errors = setError.mock.calls.length;
      body.dispose();
      outcome === "resolve"
        ? completion.resolve({
            id: "rt-111111111111",
            generation: "g-0123456789abcdef",
          })
        : completion.reject(new Error("late failure"));
      await pending;
      expect([reset.mock.calls.length, setError.mock.calls.length]).toEqual([
        0,
        errors,
      ]);
      state.panel.dispose();
    },
  );

  // The host widget no longer edits anything, so a deferred refresh can only be
  // outstanding from opening the panel. What must still hold is that a response
  // arriving after the widget is disposed re-renders nothing.
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
      // The dialog's own control is the only close: no footer repeats it.
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
});
