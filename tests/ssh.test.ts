// Every field lookup goes through control, input or picker, so a broken selector
// fails where it is read. Discovery and validation are async requests resolved
// over two microtask turns, matching how the form really resolves them. Only SSH
// host entries CyberShuttle itself wrote are editable or deletable; other
// entries are read-only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISessionCreateRequest } from "../src/Common";
import { ControlError, validateSlurmResource } from "../src/ControlClient";
import { CreateSessionForm } from "../src/CreateSessionForm";
import { SshHosts } from "../src/SshHosts";
import { SshKeys } from "../src/SshKeys";
import { SshLoginDock } from "../src/ssh";
import { controlFake, FakeOperation } from "./fakes";

const hosts = ["alpha", "beta"].map((name) => ({
  name,
  extraDirectives: [],
}));
function discovery(host: string) {
  return {
    host,
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
    homeDir: `/home/${host}`,
  };
}
function control<T extends HTMLElement>(
  form: CreateSessionForm,
  selector: string,
): T {
  const node = form.node.querySelector<T>(selector);
  if (!node) {
    throw new Error(`${selector} is unavailable`);
  }
  return node;
}

const input = (form: CreateSessionForm, name: string): HTMLInputElement =>
  control(form, `input[name="${name}"]`);
const picker = (form: CreateSessionForm, name: string): HTMLSelectElement =>
  control(form, `select[name="${name}"]`);

const hostSelect = (form: CreateSessionForm): HTMLSelectElement =>
  picker(form, "sshHost");
function choose(form: CreateSessionForm, alias: string): void {
  const host = hostSelect(form);
  if (![...host.options].some((option) => option.value === alias)) {
    throw new Error(`host alias ${alias} is not listed`);
  }
  host.value = alias;
  host.onchange?.(new Event("change"));
}
function options(form: CreateSessionForm): HTMLElement | null {
  return form.node.querySelector<HTMLElement>(".csSessionOptions");
}
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function submitForm(widget: { node: HTMLElement }): void {
  widget.node
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function reviewAndSubmit(
  form: CreateSessionForm,
): Promise<HTMLButtonElement> {
  submitForm(form);
  await vi.waitFor(() =>
    expect(form.node.textContent).toContain("Review Slurm job"),
  );
  await Promise.resolve();
  let submit: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    submit = [...form.node.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Submit",
    );
    expect(submit?.disabled).toBe(false);
  });
  submit!.click();
  return submit!;
}
type PendingDiscovery = {
  host: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

function captureCreateRequest(form: CreateSessionForm): () => any {
  let request: any;
  form.createRequested.connect((_sender, value) => {
    request = value;
  });
  return () => request;
}

async function submitValidForm(form: CreateSessionForm): Promise<void> {
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
    getTunnelLink: vi.fn(async () => ({ linked: false })),
    validateCreateRequest: vi.fn(
      async (_request: ISessionCreateRequest, _signal?: AbortSignal) => ({
        sessionId: "s-012345abcdef",
        status: "PASSED",
        script: "#!/bin/bash\n#SBATCH --partition=test\n",
        message: "Slurm accepted the script.",
      }),
    ),
  };
  const loginDock = new SshLoginDock(() => {
    const operation = new FakeOperation();
    operations.push(operation);
    return operation;
  });
  const form = new CreateSessionForm(api as any, () => loginDock);
  const deliver = async (index: number, value: unknown): Promise<void> => {
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
  return {
    form,
    api,
    loginDock,
    operations,
    discoveries,
    deliver,
    failDiscovery,
  };
}

async function discoveredAlpha(
  overrides: Record<string, unknown> = {},
): Promise<CreateSessionForm> {
  const { form, deliver } = formHarness();
  choose(form, "alpha");
  await deliver(0, { ...discovery("alpha"), ...overrides });
  return form;
}

async function pendingValidation(
  workspaceValue: string,
  configure?: (form: CreateSessionForm) => void,
  discoveryValue: unknown = discovery("alpha"),
) {
  let resolveValidation!: (value: any) => void;
  const { form, api, deliver } = formHarness();
  api.validateCreateRequest.mockImplementation(
    () => new Promise((resolve) => (resolveValidation = resolve)),
  );
  choose(form, "alpha");
  await deliver(0, discoveryValue);
  configure?.(form);
  const workspace = input(form, "rootFolder");
  workspace.value = workspaceValue;
  workspace.dispatchEvent(new Event("input"));
  submitForm(form);
  await Promise.resolve();
  await vi.waitFor(() =>
    expect(api.validateCreateRequest).toHaveBeenCalledOnce(),
  );
  const signal = api.validateCreateRequest.mock.calls[0][1];
  if (!signal) {
    throw new Error("validation was requested without an abort signal");
  }
  return { form, api, signal, resolveValidation };
}

function submitWorkspace(form: CreateSessionForm, value: string): void {
  const workspace = input(form, "rootFolder");
  workspace.value = value;
  workspace.dispatchEvent(new Event("input"));
  submitForm(form);
}

async function backAfterStaleValidation(
  form: CreateSessionForm,
  signal: AbortSignal,
  resolveValidation: (value: any) => void,
): Promise<void> {
  [...form.node.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent === "Back")!
    .click();
  expect(signal.aborted).toBe(true);
  resolveValidation({
    sessionId: "s-012345abcdef",
    status: "PASSED",
    script: "#!/bin/bash\n#SBATCH --partition=test\n",
    message: "stale",
  });
  await Promise.resolve();
}

describe("SSH CRUD and session-first creation", () => {
  it("lists configured hosts before discovery and exposes an empty-host call to action", () => {
    const { form } = formHarness();
    expect([...hostSelect(form).options].map((item) => item.value)).toEqual([
      "",
      "alpha",
      "beta",
    ]);
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
    expect(hostSelect(form).value).toBe("");
    choose(form, "alpha");
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
    expect(form.node.querySelector<HTMLElement>(".csSshAuth")?.hidden).toBe(
      true,
    );
  });

  it("opens the login console on demand and restarts discovery once", async () => {
    const { form, api, operations, discoveries, failDiscovery } = formHarness();
    choose(form, "alpha");
    await failDiscovery(
      0,
      new ControlError("ssh_authentication_required", "Duo required"),
    );
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(operation.starts).toHaveLength(1);
    expect(api.sshAuthWebSocket).toHaveBeenCalledWith("alpha");
    const { ready } = operation.starts[0].callbacks;
    expect(ready).toBeDefined();
    ready?.();
    await vi.waitFor(() => expect(discoveries).toHaveLength(2));
    await failDiscovery(
      1,
      new ControlError("ssh_authentication_required", "Still required"),
    );
    expect(operation.starts).toHaveLength(1);
    expect(form.node.textContent).toContain("already attempted");
    expect(options(form)?.hidden).toBe(true);
  });

  it("shows actionable retry after a discovery error and starts one new attempt", async () => {
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
    choose(form, "");
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

  it("rejects malformed discovery resources and retains retry/details", async () => {
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

  it("reports no partitions as an error without leaving the spinner running", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, { ...discovery("alpha"), partitions: [] });
    expect(options(form)?.hidden).toBe(true);
    expect(form.node.textContent).toContain(
      "No CPU or GPU Slurm partitions were discovered for alpha.",
    );
    expect(form.node.querySelector<HTMLElement>(".csSshAuth")?.hidden).toBe(
      true,
    );
  });

  it("ignores a shared login after the form is disposed without disposing its dock", async () => {
    const { form, loginDock, operations, discoveries, failDiscovery } =
      formHarness();
    choose(form, "alpha");
    await failDiscovery(
      0,
      new ControlError("ssh_authentication_required", "Duo required"),
    );
    expect(operations).toHaveLength(1);

    form.dispose();
    operations[0].starts[0].callbacks.ready?.();
    await Promise.resolve();

    expect(discoveries).toHaveLength(1);
    expect(operations[0].disposed).toBe(false);
    loginDock.dispose();
  });

  it("filters CPU-only discovery and omits GPU fields from the payload", async () => {
    const form = await discoveredAlpha({
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
        ?.closest<HTMLElement>(".csField")?.hidden,
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

  it("keeps WebSocket chosen and Dev Tunnel disabled without a linked account", async () => {
    const form = await discoveredAlpha();
    const mode = (value: string) =>
      control<HTMLInputElement>(form, `input[value="${value}"]`);
    expect(mode("devtunnel").disabled).toBe(true);
    mode("websocket").checked = false;
    mode("websocket").dispatchEvent(new Event("change"));
    expect(mode("websocket").checked).toBe(true);
    const request = captureCreateRequest(form);
    await submitValidForm(form);
    expect(request().tunnelModes).toEqual(["websocket"]);
  });

  it("keeps non-GPU GRES on CPU and does not drop mixed GPU partitions", async () => {
    const form = await discoveredAlpha({
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

  it("auto-selects GPU-only discovery and includes GPU fields", async () => {
    const form = await discoveredAlpha({
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
    const form = await discoveredAlpha({
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

  it("aborts validation on dispose", async () => {
    const { form, signal } = await pendingValidation("projects/dispose");

    form.dispose();
    expect(signal.aborted).toBe(true);
  });

  it("ignores stale validation after Back and preserves the draft", async () => {
    const { form, signal, resolveValidation } = await pendingValidation(
      "projects/preserved-review",
      (form) => {
        picker(form, "gpuType").value = "h100";
        picker(form, "gpuType").onchange?.(new Event("change"));
        input(form, "cores").value = "6";
        input(form, "cores").dispatchEvent(new Event("input"));
        input(form, "memoryMb").value = "8192";
        input(form, "memoryMb").dispatchEvent(new Event("input"));
        input(form, "gpuCount").value = "6";
        input(form, "gpuCount").dispatchEvent(new Event("input"));
        picker(form, "account").value = "alpha-two";
        picker(form, "account").onchange?.(new Event("change"));
      },
      {
        ...discovery("alpha"),
        partitions: [
          {
            name: "alpha-gpu",
            cpuCount: 32,
            memoryMb: 128000,
            gres: [
              { name: "gpu:a100", count: 2 },
              { name: "gpu:h100", count: 6 },
            ],
          },
        ],
      },
    );
    await backAfterStaleValidation(form, signal, resolveValidation);
    expect(form.node.textContent).not.toContain("Review Slurm job");
    expect(
      form.node.querySelector<HTMLInputElement>('input[name="rootFolder"]')
        ?.value,
    ).toBe("projects/preserved-review");
    expect(picker(form, "partition").value).toBe("gpu:0");
    expect(input(form, "cores").value).toBe("6");
    expect(input(form, "memoryMb").value).toBe("8192");
    expect(picker(form, "gpuType").value).toBe("h100");
    expect(input(form, "gpuCount").value).toBe("6");
    expect(picker(form, "account").value).toBe("alpha-two");
  });

  it("keeps no Slurm account chosen after Back", async () => {
    const { form, signal, resolveValidation } = await pendingValidation(
      "projects/preserved-no-account",
      (form) => {
        picker(form, "account").value = "";
        picker(form, "account").onchange?.(new Event("change"));
      },
    );
    await backAfterStaleValidation(form, signal, resolveValidation);
    expect(picker(form, "account").value).toBe("");
  });

  it.each([
    ["PASSED", "Validation passed.", true],
    ["FAILED", "Validation failed.", false],
  ])(
    "shows the script only when validation fails: %s",
    async (status, verdict, hidden) => {
      const form = await discoveredAlpha();
      (form as any)._api.validateCreateRequest = async () => ({
        sessionId: "s-012345abcdef",
        status,
        script: "#!/bin/bash\n#SBATCH --partition=missing\n",
        message: "Slurm answered.",
      });
      submitWorkspace(form, "$HOME");
      await vi.waitFor(() => expect(form.node.textContent).toContain(verdict));
      const script = form.node.querySelector<HTMLElement>(".csSlurmScript")!;
      expect(script.hidden).toBe(hidden);
      expect(script.textContent).toContain("--partition=missing");
      form.dispose();
    },
  );

  it("shows create errors on the review step without losing validation", async () => {
    const { form, deliver } = formHarness();
    choose(form, "alpha");
    await deliver(0, discovery("alpha"));
    const workspace = input(form, "rootFolder");
    workspace.value = "projects/create-error";
    form.createRequested.connect(() => {
      form.setBusy(true);
      form.setError("submission failed");
      form.setBusy(false);
    });
    const submit = await reviewAndSubmit(form);
    expect(form.node.textContent).toContain("submission failed");
    expect(form.node.textContent).toContain("Validation passed.");
    expect(submit.disabled).toBe(false);
  });
});

describe("SSH hosts modal chrome", () => {
  it("expands a host to what ssh uses and to what can be done about it", async () => {
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
      hostHealth: vi.fn(async () => ({ ok: true, message: "Listening." })),
    };
    const hosts = new SshHosts(controlFake(api) as any);
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
    const action = (entry: Element, label: string): HTMLButtonElement =>
      [...entry.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === label,
      )!;
    expect(action(entries[0], "Edit").disabled).toBe(false);
    expect(action(entries[0], "Delete").disabled).toBe(false);
    expect(action(entries[1], "Edit").disabled).toBe(true);
    expect(action(entries[1], "Delete").disabled).toBe(true);
    action(entries[0], "Check health").click();
    await vi.waitFor(() =>
      expect(hosts.node.textContent).toContain("Listening."),
    );
    expect(api.hostHealth).toHaveBeenCalledWith("delta");
    hosts.dispose();
  });

  it("edits a host by re-pasting a command prefilled from what is configured", async () => {
    const api = {
      listSshHosts: vi.fn(async () => [
        {
          name: "delta",
          hostname: "login.example.edu",
          user: "me",
          port: 2222,
          extraDirectives: ["ProxyJump bastion", "ForwardAgent yes"],
          managed: true,
        },
      ]),
      updateSshHost: vi.fn(async () => ({
        name: "delta",
        extraDirectives: [],
      })),
    };
    const hosts = new SshHosts(controlFake(api) as any);
    await hosts.refresh();
    const named = (label: string): HTMLButtonElement =>
      [...hosts.node.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent === label,
      )!;
    named("Edit").click();
    const command = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshHostCommand"]',
    )!;
    expect(command.value).toBe(
      "ssh -p 2222 -J bastion -o ForwardAgent=yes me@login.example.edu",
    );
    expect(hosts.node.querySelector('input[name="sshHostName"]')).toBeNull();
    command.value = "ssh -p 22 me@login2.example.edu";
    command.dispatchEvent(new Event("input"));
    submitForm(hosts);
    await vi.waitFor(() =>
      expect(api.updateSshHost).toHaveBeenCalledWith(
        "delta",
        "ssh -p 22 me@login2.example.edu",
        "",
      ),
    );
    hosts.dispose();
  });

  it("sends the pasted command for the server to parse", async () => {
    const api = {
      listSshHosts: vi.fn(async () => []),
      addSshHost: vi.fn(async () => ({ name: "delta", extraDirectives: [] })),
    };
    const hosts = new SshHosts(controlFake(api) as any);
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
    submitForm(hosts);
    await vi.waitFor(() =>
      expect(api.addSshHost).toHaveBeenCalledWith(
        "delta",
        "ssh -p 2222 me@login.example.edu",
        "",
      ),
    );
    hosts.dispose();
  });

  it("assigns a stored key from the host form and shows it on the host", async () => {
    const api = controlFake({
      listSshHosts: vi.fn(async () => [
        {
          name: "delta",
          hostname: "login.example.edu",
          keyId: "delta-key",
          extraDirectives: ["ProxyJump bastion"],
          managed: true,
        },
      ]),
      listSshKeys: vi.fn(async () => [
        { id: "delta-key", type: "ssh-ed25519", fingerprint: "SHA256:abc" },
      ]),
      updateSshHost: vi.fn(async () => ({
        name: "delta",
        extraDirectives: [],
      })),
    });
    const hosts = new SshHosts(api as any);
    await hosts.refresh();
    expect(
      [...hosts.node.querySelectorAll(".csSshArgRow")].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "HostNamelogin.example.edu",
      "Login keydelta-key",
      "ProxyJumpbastion",
    ]);
    hosts.node
      .querySelector<HTMLButtonElement>('[data-session-action="edit-delta"]')!
      .click();
    const command = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshHostCommand"]',
    )!;
    expect(command.value).toBe("ssh -J bastion login.example.edu");
    const key = hosts.node.querySelector<HTMLSelectElement>(
      'select[name="sshHostKey"]',
    )!;
    expect(key.value).toBe("delta-key");
    key.value = "";
    key.dispatchEvent(new Event("change"));
    submitForm(hosts);
    await vi.waitFor(() =>
      expect(api.updateSshHost).toHaveBeenCalledWith(
        "delta",
        "ssh -J bastion login.example.edu",
        "",
      ),
    );
    hosts.dispose();
  });
});

describe("SSH keys modal", () => {
  it("uploads a private key file under a name and confirms before deleting one", async () => {
    const api = controlFake({
      listSshKeys: vi.fn(async () => [
        { id: "old", type: "ssh-rsa", fingerprint: "SHA256:old" },
      ]),
      addSshKey: vi.fn(async () => ({
        id: "delta-key",
        type: "ssh-ed25519",
        fingerprint: "SHA256:new",
      })),
      removeSshKey: vi.fn(async () => undefined),
    });
    const hosts = new SshKeys(api as any);
    await hosts.refresh();
    hosts.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="upload-ssh-key-toggle"]',
      )!
      .click();
    const name = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshKeyName"]',
    )!;
    name.value = "delta-key";
    name.dispatchEvent(new Event("input"));
    const file = hosts.node.querySelector<HTMLInputElement>(
      'input[name="sshKeyFile"]',
    )!;
    Object.defineProperty(file, "files", {
      value: [
        new File(["-----BEGIN OPENSSH PRIVATE KEY-----\n"], "id_ed25519"),
      ],
    });
    file.dispatchEvent(new Event("change"));
    file
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(api.addSshKey).toHaveBeenCalledWith(
        "delta-key",
        "-----BEGIN OPENSSH PRIVATE KEY-----\n",
      ),
    );

    hosts.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="delete-key-old"]',
      )!
      .click();
    expect(hosts.node.textContent).toContain("unassign it?");
    expect(api.removeSshKey).not.toHaveBeenCalled();
    hosts.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="confirm-delete-key-old"]',
      )!
      .click();
    await vi.waitFor(() =>
      expect(api.removeSshKey).toHaveBeenCalledWith("old"),
    );
    hosts.dispose();
  });
});
