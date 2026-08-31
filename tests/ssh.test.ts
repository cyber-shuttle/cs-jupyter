import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlClient,
  ControlError,
  validateSlurmResource,
} from "../src/ControlClient";
import { CreateRuntimeForm } from "../src/CreateRuntimeForm";
import { FakeOperation, fakeAuth } from "./fakes";

const hosts = ["alpha", "beta"].map((name) => ({
  name,
  extraDirectives: [],
}));
function discovery(host: string) {
  return {
    host,
    homeDir: `/home/${host}`,
    accounts: [`${host}-one`, `${host}-two`],
    partitions: [
      { name: `${host}-cpu`, cpuCount: 16, memoryMb: 64000, gres: [] },
      {
        name: `${host}-gpu`,
        cpuCount: 8,
        memoryMb: 32000,
        gres: [{ name: "gpu:a100", count: 4 }],
      },
    ],
  };
}
// Every field lookup lands here, so a selector that stops matching fails where
// it is read rather than three assertions later.
function control<T extends HTMLElement>(
  form: CreateRuntimeForm,
  selector: string,
): T {
  const node = form.node.querySelector<T>(selector);
  if (!node) {
    throw new Error(`${selector} is unavailable`);
  }
  return node;
}

const input = (form: CreateRuntimeForm, name: string): HTMLInputElement =>
  control(form, `input[name="${name}"]`);
const picker = (form: CreateRuntimeForm, name: string): HTMLSelectElement =>
  control(form, `select[name="${name}"]`);

// The host is the form's first field, so choosing one is answering it.
const hostSelect = (form: CreateRuntimeForm): HTMLSelectElement =>
  picker(form, "sshHost");
function choose(form: CreateRuntimeForm, runtime: string): void {
  const host = hostSelect(form);
  if (![...host.options].some((option) => option.value === runtime)) {
    throw new Error(`runtime host ${runtime} is not listed`);
  }
  host.value = runtime;
  host.onchange?.(new Event("change"));
}
function backToHosts(form: CreateRuntimeForm): void {
  const host = hostSelect(form);
  host.value = "";
  host.onchange?.(new Event("change"));
}
function options(form: CreateRuntimeForm): HTMLElement | null {
  return form.node.querySelector<HTMLElement>(".csRuntimeOptions");
}
class AnimationFrameHarness {
  private _callbacks: FrameRequestCallback[] = [];

  readonly request = (callback: FrameRequestCallback): number => {
    this._callbacks.push(callback);
    return this._callbacks.length;
  };

  get pending(): number {
    return this._callbacks.length;
  }

  advance(): void {
    const callback = this._callbacks.shift();
    if (!callback) {
      throw new Error("No animation frame is pending.");
    }
    callback(0);
  }
}

let animationFrames: AnimationFrameHarness;

beforeEach(() => {
  animationFrames = new AnimationFrameHarness();
  vi.stubGlobal("requestAnimationFrame", animationFrames.request);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function submitConfiguration(form: CreateRuntimeForm): void {
  form.node
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function advanceToValidation(): Promise<void> {
  await Promise.resolve();
}

async function reviewAndSubmit(form: CreateRuntimeForm): Promise<void> {
  submitConfiguration(form);
  await vi.waitFor(() =>
    expect(form.node.textContent).toContain("Review Slurm job"),
  );
  await advanceToValidation();
  let submit: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    submit = [...form.node.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Submit",
    );
    expect(submit?.disabled).toBe(false);
  });
  submit!.click();
}
type PendingDiscovery = {
  host: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

function captureCreateRequest(form: CreateRuntimeForm): () => any {
  let request: any;
  form.createRequested.connect((_sender, value) => {
    request = value;
  });
  return () => request;
}

async function submitValidForm(form: CreateRuntimeForm): Promise<void> {
  const submit = control<HTMLButtonElement>(form, 'button[type="submit"]');
  expect(submit.disabled).toBe(false);
  expect(form.node.querySelector("form")?.reportValidity()).toBe(true);
  await reviewAndSubmit(form);
}

function formHarness() {
  const operations: FakeOperation[] = [];
  const discoveries: PendingDiscovery[] = [];
  const api = {
    discoverSlurm: vi.fn(
      (host: string) =>
        new Promise<unknown>((resolve, reject) => {
          discoveries.push({ host, resolve, reject });
        }),
    ),
    sshAuthWebSocket: vi.fn((_host: string) => vi.fn()),
    validateRuntime: vi.fn(async () => ({
      runtimeId: "rt-012345abcdef",
      status: "PASSED",
      script: "#!/bin/bash\n#SBATCH --partition=test\n",
      message: "Slurm accepted the script.",
    })),
  };
  const form = new CreateRuntimeForm(api as any, () => {
    const operation = new FakeOperation();
    operations.push(operation);
    return operation;
  });
  // Discovery is a request now, so delivering a result is a promise settlement
  // and every assertion after one has to wait a microtask turn.
  const deliver = async (index: number, value: unknown): Promise<void> => {
    // The real client validates the response before the form sees it, so the
    // fake must too or a malformed payload would reach code that never gets one.
    try {
      discoveries[index].resolve(validateSlurmResource(value));
    } catch (error) {
      discoveries[index].reject(error);
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const failDiscovery = async (
    index: number,
    reason: unknown,
  ): Promise<void> => {
    discoveries[index].reject(reason);
    await Promise.resolve();
    await Promise.resolve();
  };
  form.setHosts(hosts);
  return { form, api, operations, discoveries, deliver, failDiscovery };
}

// A validation left in flight: the form has submitted, the request is out, and
// nothing has answered it yet.
async function pendingValidation(workspaceValue: string) {
  let resolveValidation!: (value: any) => void;
  const { form, api, deliver } = formHarness();
  api.validateRuntime.mockImplementation(
    () => new Promise((resolve) => (resolveValidation = resolve)),
  );
  choose(form, "alpha");
  await deliver(0, discovery("alpha"));
  const workspace = input(form, "rootFolder");
  workspace.value = workspaceValue;
  workspace.dispatchEvent(new Event("input"));
  submitConfiguration(form);
  await advanceToValidation();
  await vi.waitFor(() => expect(api.validateRuntime).toHaveBeenCalledOnce());
  return {
    form,
    api,
    signal: api.validateRuntime.mock.calls[0][1] as AbortSignal,
    resolveValidation,
  };
}

describe("SSH CRUD and streamed runtime-first creation", () => {
  it("uses an OAuth bearer on cs-control host routes without XSRF", async () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      value: "_xsrf=test-xsrf",
    });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            hosts: [
              {
                name: "delta",
                hostname: "delta.example",
                port: 22,
                extraDirectives: [],
              },
            ],
          }),
        ),
    );
    const client = new ControlClient(
      "http://localhost:3000/api/v1",
      fakeAuth("test-delegated-token"),
      fetch as any,
    );
    await client.listSshHosts();
    const requests = fetch.mock.calls.map(
      ([input, init]) => new Request(input as RequestInfo, init as RequestInit),
    );
    expect(requests.map((item) => item.method)).toEqual(["GET"]);
    expect(
      requests.every(
        (item) =>
          item.headers.get("Authorization") === "Bearer test-delegated-token",
      ),
    ).toBe(true);
    expect(requests.every((item) => !item.headers.has("X-XSRFToken"))).toBe(
      true,
    );
  });

  it("lists configured hosts before discovery and exposes an empty-host call to action", () => {
    const operations: FakeOperation[] = [];
    const form = new CreateRuntimeForm({} as any, () => {
      const operation = new FakeOperation();
      operations.push(operation);
      return operation;
    });
    form.setHosts([
      {
        name: "system-host",
        hostname: "login.example.edu",
        user: "alice",
        port: 2222,
        extraDirectives: [],
      },
    ]);
    expect([...hostSelect(form).options].map((item) => item.value)).toEqual([
      "",
      "system-host",
    ]);
    expect(operations).toHaveLength(0);
    form.setHosts([]);
    expect(form.node.textContent).toContain("No SSH hosts are configured.");
    expect(
      [...form.node.querySelectorAll("button")].some(
        (item) => item.textContent === "Manage SSH hosts",
      ),
    ).toBe(true);
  });

  it("starts with host selection and reveals options after a valid result", async () => {
    const { form, api, operations, deliver } = formHarness();
    expect(options(form)?.hidden).toBe(true);
    expect(operations).toHaveLength(0);
    expect(hostSelect(form).value).toBe("");
    choose(form, "alpha");
    // Discovery is a plain request, so no login console is opened for it.
    expect(operations).toHaveLength(0);
    expect(options(form)?.hidden).toBe(true);
    expect(
      [...form.node.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === "Cancel",
      )?.hidden,
    ).toBe(false);
    expect(api.discoverSlurm).toHaveBeenCalledWith("alpha", expect.anything());
    await deliver(0, discovery("alpha"));
    expect(options(form)?.hidden).toBe(false);
    expect(
      form.node.querySelector<HTMLSelectElement>('select[name="account"]')
        ?.value,
    ).toBe("alpha-one");
    // The expanded form is the result, so the query row retires with it.
    expect(form.node.querySelector<HTMLElement>(".csSshAuth")?.hidden).toBe(
      true,
    );
  });

  it("opens the login console on demand and restarts discovery once", async () => {
    const { form, api, operations, discoveries, failDiscovery } = formHarness();
    choose(form, "alpha");
    expect(operations).toHaveLength(0);
    await failDiscovery(
      0,
      new ControlError("ssh_authentication_required", "Duo required"),
    );
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(operation.starts).toHaveLength(1);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("alpha");
    operation.starts[0].callbacks.ready();
    expect(discoveries).toHaveLength(2);
    await failDiscovery(
      1,
      new ControlError("ssh_authentication_required", "Still required"),
    );
    expect(operation.starts).toHaveLength(1);
    expect(form.node.textContent).toContain("already attempted");
    expect(options(form)?.hidden).toBe(true);
  });

  it("shows actionable retry after stream error and starts one new attempt", async () => {
    const { form, discoveries, failDiscovery } = formHarness();
    choose(form, "alpha");
    await failDiscovery(0, new Error("scheduler unavailable"));
    const retry = [...form.node.querySelectorAll("button")].find(
      (item) => item.textContent === "Retry",
    )!;
    expect(retry.hidden).toBe(false);
    expect(options(form)?.hidden).toBe(true);
    retry.click();
    expect(discoveries).toHaveLength(2);
  });

  it("ignores a stale discovery result after switching hosts", async () => {
    const { form, discoveries, deliver } = formHarness();
    choose(form, "alpha");
    backToHosts(form);
    choose(form, "beta");
    expect(discoveries).toHaveLength(2);
    await deliver(0, discovery("alpha"));
    expect(options(form)?.hidden).toBe(true);
    await deliver(1, discovery("beta"));
    expect(options(form)?.hidden).toBe(false);
    expect(
      form.node.querySelector<HTMLSelectElement>('select[name="account"]')
        ?.value,
    ).toBe("beta-one");
  });

  it("rejects malformed streamed resources and retains retry/details", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      host: "alpha",
      accounts: null,
    });
    expect(options(form)?.hidden).toBe(true);
    expect(form.node.textContent).toContain("invalid Slurm discovery");
    expect(
      [...form.node.querySelectorAll("button")].some(
        (item) => item.textContent === "Retry" && !item.hidden,
      ),
    ).toBe(true);
  });

  it("aborts discovery and disposes the login console when the form is disposed", async () => {
    const { form, operations, failDiscovery } = formHarness();
    choose(form, "alpha");
    await failDiscovery(
      0,
      new ControlError("ssh_authentication_required", "Duo required"),
    );
    expect(operations).toHaveLength(1);
    form.dispose();
    expect(operations[0].cancelled).toBeGreaterThan(0);
    expect(operations[0].disposed).toBe(true);
  });

  it("filters CPU-only discovery and omits GPU fields from the payload", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      ...discovery("alpha"),
      partitions: [{ name: "cpu", cpuCount: 32, memoryMb: 128000, gres: [] }],
    });
    const partition = picker(form, "partition");
    expect([...partition.options].map((item) => item.textContent)).toEqual([
      "cpu — 32 CPU · 128000 MB",
    ]);
    expect(
      form.node.querySelector(".csResourceType")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      form.node
        .querySelector<HTMLElement>('select[name="gpuType"]')
        ?.closest(".csField")?.hidden,
    ).toBe(true);
    const workspace = input(form, "rootFolder");
    workspace.value = "projects/cpu";
    workspace.dispatchEvent(new Event("input"));
    const request = captureCreateRequest(form);
    await submitValidForm(form);
    expect(request().partition).toBe("cpu");
    expect(request().resources).not.toHaveProperty("gpuType");
    expect(request().resources).not.toHaveProperty("gpuCount");
  });

  it("keeps non-GPU GRES on CPU and does not drop mixed GPU partitions", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      ...discovery("alpha"),
      partitions: [
        {
          name: "licensed-cpu",
          cpuCount: 32,
          memoryMb: 128000,
          gres: [{ name: "shard:matlab", count: 1 }],
        },
        {
          name: "generic-gpu",
          cpuCount: 16,
          memoryMb: 64000,
          gres: [{ name: "gpu", count: 2 }],
        },
        {
          name: "mixed-gpu",
          cpuCount: 24,
          memoryMb: 96000,
          gres: [
            { name: "shard:matlab", count: 1 },
            { name: "gpu:h100", count: 4 },
          ],
        },
      ],
    });

    const partition = picker(form, "partition");
    expect([...partition.options].map((item) => item.textContent)).toEqual([
      "licensed-cpu — 32 CPU · 128000 MB",
    ]);

    const gpu = control<HTMLInputElement>(
      form,
      'input[name="resourceType"][value="gpu"]',
    );
    gpu.checked = true;
    gpu.dispatchEvent(new Event("change"));
    expect([...partition.options].map((item) => item.textContent)).toEqual([
      "generic-gpu — 16 CPU · 64000 MB · 2× Generic GPU",
      "mixed-gpu — 24 CPU · 96000 MB · 4× h100",
    ]);
  });

  it("submits generic GPU GRES using the stable gpu type", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      ...discovery("alpha"),
      partitions: [
        {
          name: "accelerated",
          cpuCount: 16,
          memoryMb: 64000,
          gres: [{ name: "gpu", count: 2 }],
        },
      ],
    });
    const gpuType = picker(form, "gpuType");
    expect(gpuType.value).toBe("gpu");
    expect(gpuType.selectedOptions[0].textContent).toBe("Generic GPU");

    const workspace = input(form, "rootFolder");
    workspace.value = "projects/generic-gpu";
    const request = captureCreateRequest(form);
    await reviewAndSubmit(form);
    expect(request().partition).toBe("accelerated");
    expect(request().resources).toMatchObject({ gpuType: "gpu", gpuCount: 1 });
  });

  it("auto-selects GPU-only discovery and includes GPU fields", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      ...discovery("alpha"),
      partitions: [
        {
          name: "gpu",
          cpuCount: 16,
          memoryMb: 64000,
          gres: [{ name: "gpu:h100", count: 2 }],
        },
      ],
    });
    expect(
      form.node.querySelector<HTMLInputElement>(
        'input[name="resourceType"]:checked',
      )?.value,
    ).toBe("gpu");
    expect(
      form.node.querySelector<HTMLSelectElement>('select[name="gpuType"]')
        ?.value,
    ).toBe("h100");
    const workspace = input(form, "rootFolder");
    workspace.value = "projects/gpu";
    const request = captureCreateRequest(form);
    await submitValidForm(form);
    expect(request().resources).toMatchObject({ gpuType: "h100", gpuCount: 1 });
  });

  it("shows CPU and GPU as top-level choices and resets bounded resources on switch", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, discovery("alpha"));
    const radios = [
      ...form.node.querySelectorAll<HTMLInputElement>(
        'input[name="resourceType"]',
      ),
    ];
    expect(radios.map((item) => item.value)).toEqual(["cpu", "gpu"]);
    expect(radios.find((item) => item.checked)?.value).toBe("cpu");
    const cores = input(form, "cores");
    const memory = input(form, "memoryMb");
    cores.value = "12";
    cores.dispatchEvent(new Event("input"));
    memory.value = "12000";
    memory.dispatchEvent(new Event("input"));
    const gpu = radios.find((item) => item.value === "gpu")!;
    gpu.checked = true;
    gpu.dispatchEvent(new Event("change"));
    expect(cores.value).toBe("2");
    expect(memory.value).toBe("4096");
    expect([cores.min, memory.min]).toEqual(["2", "4096"]);
    expect(
      [
        ...form.node.querySelectorAll<HTMLOptionElement>(
          'select[name="partition"] option',
        ),
      ].map((item) => item.textContent),
    ).toEqual(["alpha-gpu — 8 CPU · 32000 MB · 4× a100"]);
  });

  it("keeps duplicate scheduler partition names deterministic and submits the real name", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, {
      ...discovery("alpha"),
      partitions: [
        { name: "full", cpuCount: 32, memoryMb: 64000, gres: [] },
        { name: "full", cpuCount: 64, memoryMb: 128000, gres: [] },
        {
          name: "full",
          cpuCount: 16,
          memoryMb: 96000,
          gres: [{ name: "gpu:a100", count: 4 }],
        },
      ],
    });
    const partition = picker(form, "partition");
    expect([...partition.options].map((item) => item.value)).toEqual([
      "cpu:0",
      "cpu:1",
    ]);
    expect([...partition.options].map((item) => item.textContent)).toEqual([
      "full — 32 CPU · 64000 MB",
      "full — 64 CPU · 128000 MB",
    ]);
    partition.value = "cpu:1";
    partition.dispatchEvent(new Event("change"));
    const workspace = input(form, "rootFolder");
    workspace.value = "projects/full";
    const request = captureCreateRequest(form);
    await submitValidForm(form);
    expect(request().partition).toBe("full");
  });

  it.each([".", "$HOME/work", "/scratch/user/work"])(
    "preserves raw workspace expression %s in the create payload",
    async (expression) => {
      const { form, deliver } = formHarness();
      choose(form, "alpha");
      await deliver(0, discovery("alpha"));
      const workspace = input(form, "rootFolder");
      expect(workspace.getAttribute("aria-describedby")).toBe(
        "cybershuttle-workspace-help",
      );
      expect(form.node.textContent).toContain("~/cybershuttle");
      expect(form.node.textContent).toContain("$HOME/work");
      expect(form.node.textContent).toContain("/scratch/user/work");
      workspace.value = expression;
      workspace.dispatchEvent(new Event("input"));
      const request = captureCreateRequest(form);
      await reviewAndSubmit(form);
      expect(request().rootFolder).toBe(expression);
    },
  );

  it("aborts validation on dispose and ignores its stale response", async () => {
    const { form, signal, resolveValidation } =
      await pendingValidation("projects/dispose");

    form.dispose();
    expect(signal.aborted).toBe(true);
    resolveValidation({
      runtimeId: "rt-012345abcdef",
      status: "PASSED",
      script: "#!/bin/bash\n#SBATCH --partition=test\n",
      message: "stale",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(form.isDisposed).toBe(true);
  });

  it("ignores stale validation after Back and preserves the draft", async () => {
    const { form, signal, resolveValidation } = await pendingValidation(
      "projects/preserved-review",
    );
    [...form.node.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "Back")!
      .click();
    expect(signal.aborted).toBe(true);
    resolveValidation({
      runtimeId: "rt-012345abcdef",
      status: "PASSED",
      script: "#!/bin/bash\n#SBATCH --partition=test\n",
      message: "stale",
    });
    await Promise.resolve();
    expect(form.node.textContent).not.toContain("3. Review Slurm job");
    expect(
      form.node.querySelector<HTMLInputElement>('input[name="rootFolder"]')
        ?.value,
    ).toBe("projects/preserved-review");
  });

  it("waits on validation before showing the script it validated", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, discovery("alpha"));
    const validation = Promise.withResolvers<unknown>();
    (form as any)._api.validateRuntime = () => validation.promise;
    const workspace = input(form, "rootFolder");
    workspace.value = "$HOME";
    workspace.dispatchEvent(new Event("input"));
    submitConfiguration(form);
    await vi.waitFor(() =>
      expect(form.node.textContent).toContain("Validating with Slurm"),
    );
    expect(form.node.querySelector(".csSlurmScript")?.textContent).toBe("");
    validation.resolve({
      runtimeId: "rt-012345abcdef",
      status: "PASSED",
      script: "#!/bin/bash\n#SBATCH --partition=test\n",
      message: "Slurm accepted the script.",
    });
    await vi.waitFor(() =>
      expect(form.node.querySelector(".csSlurmScript")?.textContent).toContain(
        "#!/bin/bash",
      ),
    );
    form.dispose();
  });

  it("shows create errors on the review step without losing validation", async () => {
    const { form, api, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, discovery("alpha"));
    const workspace = input(form, "rootFolder");
    workspace.value = "projects/create-error";
    form.createRequested.connect(() => {
      form.setBusy(true);
      form.setError("submission failed");
      form.setBusy(false);
    });
    submitConfiguration(form);
    await advanceToValidation();
    let submit: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      submit = [
        ...form.node.querySelectorAll<HTMLButtonElement>("button"),
      ].find((item) => item.textContent === "Submit");
      expect(submit?.disabled).toBe(false);
    });
    submit!.click();
    expect(form.node.textContent).toContain("submission failed");
    expect(form.node.textContent).toContain("Validation passed.");
    expect(submit!.disabled).toBe(false);
  });
});

describe("SSH hosts modal chrome", () => {
  it("opens with its meaning and a rule, and carries no close of its own", async () => {
    const { SshHosts } = await import("../src/SshHosts");
    const hosts = new SshHosts({
      listSshHosts: async () => [],
    } as unknown as ControlClient);
    const root = hosts.node.querySelector(".csRoot")!;
    // The dialog names itself and closes itself, so the body does neither.
    expect(root.querySelector(".csFormTitle")).toBeNull();
    expect(root.querySelector(".csModalClose")).toBeNull();
    expect(root.textContent).not.toContain("← Back");
    expect(
      [...root.children]
        .map((node) => node.className.split(" ")[0])
        .slice(0, 2),
    ).toEqual(["csModalSubtitle", "csModalRule"]);
    expect(root.querySelector(".csModalSubtitle")?.textContent).toContain(
      "~/.ssh/config",
    );
    hosts.dispose();
  });

  it("expands a host to what ssh uses and to what can be done about it", async () => {
    const { SshHosts } = await import("../src/SshHosts");
    const api = {
      listSshHosts: vi.fn(async () => [
        {
          name: "delta",
          hostname: "login.example.edu",
          user: "me",
          port: 2222,
          extraDirectives: ["ProxyJump bastion"],
          managed: true,
        },
        { name: "theirs", hostname: "own.example.edu", extraDirectives: [] },
      ]),
      testSshHost: vi.fn(async () => ({ ok: true, message: "Connected." })),
    };
    const hosts = new SshHosts(api as unknown as ControlClient);
    await hosts.refresh();
    const entries = [
      ...hosts.node.querySelectorAll<HTMLDetailsElement>(".csSshHostEntry"),
    ];
    expect(entries).toHaveLength(2);
    expect(
      [...entries[0].querySelectorAll(".csSshArgRow")].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "HostNamelogin.example.edu",
      "Userme",
      "Port2222",
      "ProxyJumpbastion",
    ]);
    const [test, remove] = [
      ...entries[0].querySelectorAll<HTMLButtonElement>("button"),
    ];
    // Only the entry CyberShuttle wrote is CyberShuttle's to remove.
    expect(remove.disabled).toBe(false);
    expect(
      [...entries[1].querySelectorAll<HTMLButtonElement>("button")][1].disabled,
    ).toBe(true);
    test.click();
    await vi.waitFor(() =>
      expect(hosts.node.textContent).toContain("Connected."),
    );
    expect(api.testSshHost).toHaveBeenCalledWith("delta");
    hosts.dispose();
  });

  it("asks before removing, in the row rather than behind a queued dialog", async () => {
    const { SshHosts } = await import("../src/SshHosts");
    const api = {
      listSshHosts: vi.fn(async () => [
        {
          name: "delta",
          hostname: "a.example.edu",
          extraDirectives: [],
          managed: true,
        },
      ]),
      removeSshHost: vi.fn(async () => undefined),
    };
    const hosts = new SshHosts(api as unknown as ControlClient);
    await hosts.refresh();
    const remove = (): HTMLButtonElement =>
      [...hosts.node.querySelectorAll<HTMLButtonElement>("button")].filter(
        (item) => item.textContent === "Delete",
      )[0];
    remove().click();
    expect(hosts.node.textContent).toContain("Remove this entry");
    expect(api.removeSshHost).not.toHaveBeenCalled();
    remove().click();
    await vi.waitFor(() =>
      expect(api.removeSshHost).toHaveBeenCalledWith("delta"),
    );
    hosts.dispose();
  });

  it("sends the pasted command for the server to parse", async () => {
    const { SshHosts } = await import("../src/SshHosts");
    const api = {
      listSshHosts: vi.fn(async () => []),
      addSshHost: vi.fn(async () => ({ name: "delta", extraDirectives: [] })),
    };
    const hosts = new SshHosts(api as unknown as ControlClient);
    [...hosts.node.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent === "Add SSH Host")!
      .click();
    const name = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshHostName"]',
    )!;
    const command = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshHostCommand"]',
    )!;
    name.value = "delta";
    name.dispatchEvent(new Event("input"));
    command.value = " ssh -p 2222 me@login.example.edu ";
    command.dispatchEvent(new Event("input"));
    hosts.node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(api.addSshHost).toHaveBeenCalledWith(
        "delta",
        "ssh -p 2222 me@login.example.edu",
      ),
    );
    hosts.dispose();
  });
});
