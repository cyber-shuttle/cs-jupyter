import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import {
  IPartition,
  IRuntime,
  IRuntimeCreateRequest,
  IRuntimeValidation,
  ISlurmInfo,
  ISshHost,
} from "./Common";
import { ControlClient, ControlError, errorMessage } from "./ControlClient";
import {
  createSshOperationConsole,
  ISshOperationConsole,
  SshOperationConsoleFactory,
} from "./SshOperationConsole";
import { button, element, field } from "./dom";

type ResourceType = "cpu" | "gpu";

interface IPartitionChoice {
  key: string;
  partition: IPartition;
}

interface IRuntimeDraft {
  sshHost: string;
  resourceType: ResourceType | "";
  account: string;
  partitionKey: string;
  rootFolder: string;
  cores: number;
  memoryMb: number;
  wallMinutes: number;
  gpuType: string;
  gpuCount: number;
}

function freshDraft(sshHost = ""): IRuntimeDraft {
  return {
    sshHost,
    resourceType: "",
    account: "",
    partitionKey: "",
    rootFolder: "",
    cores: 1,
    memoryMb: 1024,
    wallMinutes: 60,
    gpuType: "",
    gpuCount: 1,
  };
}

export class CreateRuntimeForm extends Widget {
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly createRequested = new Signal<this, IRuntimeCreateRequest>(this);
  private _hosts: ISshHost[] = [];
  private _hostsKey = "";
  private _slurm: ISlurmInfo | undefined;
  private _busy = false;
  private _error = "";
  private _key = crypto.randomUUID();
  private _payload = "";
  private _operationGeneration = 0;
  private _discoveryAbort: AbortController | undefined;
  private _operation: ISshOperationConsole | undefined;
  private _create: HTMLButtonElement | undefined;
  private _errorNode: HTMLElement | undefined;
  private _partition: HTMLSelectElement | undefined;
  private _partitionChoices: IPartitionChoice[] = [];
  private _draft = freshDraft();
  private _reviewRequest: IRuntimeCreateRequest | undefined;
  private _validation: IRuntimeValidation | undefined;
  private _validationError = "";
  private _validating = false;
  private _validationGeneration = 0;
  private _reviewAbort: AbortController | undefined;
  private _reviewSubmit: HTMLButtonElement | undefined;
  private _reviewStatus: HTMLElement | undefined;
  private _reviewError: HTMLElement | undefined;

  constructor(
    private _api: ControlClient,
    private _operationFactory: SshOperationConsoleFactory = createSshOperationConsole,
  ) {
    super();
    this.id = "cybershuttle-create-runtime";
    this.addClass("csRuntimePanel");
    this.hide();
    this._render();
  }

  setHosts(hosts: ISshHost[]): void {
    const key = JSON.stringify(hosts);
    if (key === this._hostsKey) {
      return;
    }
    this._hosts = hosts;
    this._hostsKey = key;
    if (
      this._draft.sshHost &&
      !hosts.some((host) => host.name === this._draft.sshHost)
    ) {
      this._selectHost("");
    }
    this._render();
  }

  setBusy(busy: boolean): void {
    this._busy = busy;
    this._syncStatus();
  }

  setError(message: string): void {
    this._error = message;
    this._syncStatus();
  }

  // The partition is not carried over: partitions come from discovery, which
  // has not run for this host yet.
  prefill(runtime: IRuntime): void {
    this._selectHost(runtime.sshHost);
    this._draft = {
      ...this._draft,
      account: runtime.account ?? "",
      rootFolder: runtime.rootFolder,
      cores: runtime.resources.cores,
      memoryMb: runtime.resources.memoryMb,
      wallMinutes: runtime.resources.wallMinutes,
      gpuType: runtime.resources.gpuType ?? "",
      gpuCount: runtime.resources.gpuCount ?? 1,
    };
    this._render();
  }

  resetRequestIdentity(): void {
    this._key = crypto.randomUUID();
    this._payload = "";
    this._leaveReview();
    this._selectHost("");
    this._render();
  }

  dispose(): void {
    this._stopOperation();
    this._cancelReviewOperation();
    super.dispose();
  }

  private _selectHost(alias: string): void {
    this._stopOperation();
    this._leaveReview();
    this._slurm = undefined;
    this._partitionChoices = [];
    this._draft = freshDraft(alias);
    this._error = "";
  }

  private _stopOperation(): void {
    this._operationGeneration++;
    this._discoveryAbort?.abort();
    this._discoveryAbort = undefined;
    this._operation?.cancel();
    this._operation?.dispose();
    this._operation = undefined;
  }

  private _cancelReviewOperation(): void {
    this._validationGeneration++;
    this._reviewAbort?.abort();
    this._reviewAbort = undefined;
    this._validating = false;
  }

  private _leaveReview(): void {
    this._cancelReviewOperation();
    this._reviewRequest = undefined;
    this._validation = undefined;
    this._validationError = "";
    this._reviewSubmit = undefined;
    this._reviewStatus = undefined;
    this._reviewError = undefined;
  }

  private _syncStatus(): void {
    if (this._create) {
      this._create.textContent = this._busy ? "Creating…" : "Create";
      const selected = this._partitionChoices.find(
        (item) => item.key === this._partition?.value,
      );
      this._create.disabled = this._busy || !selected;
    }
    if (this._errorNode) {
      this._errorNode.textContent = this._error;
      this._errorNode.hidden = !this._error;
    }
    if (this._reviewSubmit) {
      this._reviewSubmit.textContent = this._busy ? "Submitting…" : "Submit";
      this._reviewSubmit.disabled =
        this._busy || this._validating || this._validation?.status !== "PASSED";
    }
    if (this._reviewStatus) {
      const state = this._validating
        ? "Validating with Slurm…"
        : this._validation?.status === "PASSED"
          ? `Validation passed. ${this._validation.message}`
          : this._validation?.status === "FAILED"
            ? `Validation failed. ${this._validation.message}`
            : this._validationError || "Script unavailable.";
      const busy = this._validating;
      this._reviewStatus.textContent = "";
      if (busy) {
        this._reviewStatus.appendChild(element("span", "", "csSpinner"));
      }
      this._reviewStatus.appendChild(document.createTextNode(state));
      this._reviewStatus.className = `csValidationStatus${
        busy
          ? " csValidationStatusBusy"
          : this._validation?.status === "PASSED"
            ? " csValidationPassed"
            : this._validation?.status === "FAILED" || this._validationError
              ? " csValidationFailed"
              : ""
      }`;
    }
    if (this._reviewError) {
      const detail =
        this._error || this._validation?.stderr || this._validationError;
      this._reviewError.textContent = detail;
      this._reviewError.hidden = !detail;
    }
  }

  private _render(): void {
    this._stopOperation();
    this.node.textContent = "";
    this._create = undefined;
    this._errorNode = undefined;
    this._partition = undefined;
    this._reviewSubmit = undefined;
    this._reviewStatus = undefined;
    this._reviewError = undefined;
    const root = element("div", "", "csRoot");
    root.append(
      element("hr", "", "csModalRule"),
      this._reviewRequest
        ? this._buildReviewStep()
        : this._buildConfigurationStep(),
    );
    this.node.appendChild(root);
  }

  private _buildReviewStep(): HTMLElement {
    const request = this._reviewRequest;
    if (!request) {
      throw new Error("Runtime review request is unavailable.");
    }
    const container = element("div");
    container.appendChild(
      button("← Back to configuration", "csTextButton", () => {
        this._leaveReview();
        this._render();
      }),
    );

    const review = element("section", "", "csRuntimeReview");
    const heading = element("h2", "Review Slurm job", "csStepHeading");
    const description = element(
      "p",
      "Review the exact Slurm script generated by cs-control. Submission is enabled only after Slurm validation passes.",
      "csMeta",
    );
    const scriptHeader = element("div", "", "csScriptHeader");
    const scriptLabel = element("label", "Generated Slurm script", "csLabel");
    scriptLabel.htmlFor = "cybershuttle-slurm-script";
    const copy = button("Copy script", "csSecondaryButton", () => {
      if (this._validation) {
        void navigator.clipboard?.writeText(this._validation.script);
      }
    });
    copy.disabled = !this._validation;
    scriptHeader.append(scriptLabel, copy);
    const script = document.createElement("pre");
    script.id = "cybershuttle-slurm-script";
    script.className = "csSlurmScript";
    script.setAttribute("tabindex", "0");
    script.textContent = this._validation?.script || "Validating script…";

    const status = element("div", "", "csValidationStatus");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    this._reviewStatus = status;
    const validationError = element("pre", "", "csValidationError");
    this._reviewError = validationError;
    const retry = button("Retry validation", "csSecondaryButton", () => {
      void this._retryValidation();
    });
    retry.hidden =
      this._validating ||
      (!this._validationError && this._validation?.status !== "FAILED");

    const footer = element("div", "", "csFormFooter");
    const back = button("Back", "csSecondaryButton", () => {
      this._leaveReview();
      this._render();
    });
    const submit = button("Submit", "csPrimaryButton", () => {
      if (
        !this._busy &&
        !this._validating &&
        this._validation?.status === "PASSED" &&
        this._reviewRequest
      ) {
        this.createRequested.emit(cloneRequest(this._reviewRequest));
      }
    });
    this._reviewSubmit = submit;
    footer.append(back, submit);
    review.append(
      heading,
      description,
      scriptHeader,
      script,
      status,
      validationError,
      retry,
      footer,
    );
    container.appendChild(review);
    this._syncStatus();
    return container;
  }

  private _currentReview(
    request: IRuntimeCreateRequest,
    generation: number,
  ): boolean {
    return (
      !this.isDisposed &&
      generation === this._validationGeneration &&
      this._reviewRequest === request
    );
  }

  private async _retryValidation(): Promise<void> {
    const request = this._reviewRequest;
    if (!request || this.isDisposed) return;
    this._cancelReviewOperation();
    const generation = this._validationGeneration;
    const abort = new AbortController();
    this._reviewAbort = abort;
    this._validation = undefined;
    this._validationError = "";
    this._validating = true;
    this._render();
    try {
      const validation = await this._api.validateRuntime(
        cloneRequest(request),
        abort.signal,
      );
      if (this._currentReview(request, generation)) {
        this._validation = validation;
      }
    } catch (error) {
      if (!abort.signal.aborted && this._currentReview(request, generation)) {
        this._validationError = errorMessage(error);
      }
    }
    if (this._currentReview(request, generation)) {
      this._validating = false;
      this._reviewAbort = undefined;
      this._render();
    }
  }

  private _buildConfigurationStep(): HTMLElement {
    const container = element("div");
    const form = document.createElement("form");
    form.className = "csForm";

    const host = select("sshHost", [
      [
        "",
        this._hosts.length ? "Select a host…" : "No SSH hosts are configured.",
      ],
      ...this._hosts.map((item) => [item.name, item.name] as [string, string]),
    ]);
    host.value = this._draft.sshHost;
    host.required = true;
    host.disabled = !this._hosts.length;
    host.onchange = () => {
      this._selectHost(host.value);
      this._render();
    };
    form.appendChild(field("SSH Host", host));
    if (!this._hosts.length) {
      form.appendChild(
        button("Manage SSH hosts", "csTextButton", () =>
          this.sshHostsRequested.emit(undefined),
        ),
      );
    }

    const operationArea = element("section", "", "csSshAuth");
    operationArea.hidden = !this._draft.sshHost;
    const operationHeader = element("div", "", "csSshAuthHeader");
    const spinner = element("span", "", "csSpinner");
    const operationTitle = element("strong", "SLURM discovery");
    const cancelOperation = button(
      "Cancel",
      "csTextButton csDiscoveryCancel",
      () => undefined,
    );
    cancelOperation.hidden = true;
    operationHeader.append(spinner, operationTitle, cancelOperation);
    // Discovery is a plain request, so its outcome has to be readable here.
    // The console below only ever holds an interactive login transcript.
    const operationStatus = element("div", "", "csSshAuthStatus");
    operationStatus.setAttribute("role", "status");
    const consoleHost = element("div", "", "csSshAuthHost");
    const retry = button("Retry", "csSecondaryButton", () => undefined);
    retry.hidden = true;
    operationArea.append(operationHeader, operationStatus, consoleHost, retry);
    form.appendChild(operationArea);

    const options = element("div", "", "csRuntimeOptions");
    options.hidden = true;
    const resourceType = document.createElement("fieldset");
    resourceType.className = "csResourceType";
    const resourceLegend = document.createElement("legend");
    resourceLegend.textContent = "Resource type";
    resourceLegend.className = "csLabel";
    const resourceChoices = element("div", "", "csResourceTypeChoices");
    resourceType.append(resourceLegend, resourceChoices);
    const account = select("account", []);
    account.required = false;
    const partition = select("partition", []);
    this._partition = partition;
    const rootFolder = input(
      "rootFolder",
      "text",
      "~/cybershuttle or $PROJECT/work",
    );
    rootFolder.value = this._draft.rootFolder;
    const workspaceHelp = element(
      "div",
      "Examples: . · ~/cybershuttle · $HOME/work · /scratch/user/work",
      "csFieldHelp",
    );
    workspaceHelp.id = "cybershuttle-workspace-help";
    rootFolder.setAttribute("aria-describedby", workspaceHelp.id);
    const workspaceField = field("Workspace folder", rootFolder);
    workspaceField.appendChild(workspaceHelp);
    const cores = number("cores", this._draft.cores);
    const memory = number("memoryMb", this._draft.memoryMb);
    const wall = number("wallMinutes", this._draft.wallMinutes);
    const gpuType = select("gpuType", []);
    const gpuCount = number("gpuCount", this._draft.gpuCount);
    const gpuTypeField = field("GPU type", gpuType);
    const gpuCountField = field("GPUs", gpuCount);
    options.append(
      resourceType,
      field("Allocation account", account),
      field("Partition", partition),
      workspaceField,
      field("Cores", cores),
      field("Memory (MB)", memory),
      field("Wall time (minutes)", wall),
      gpuTypeField,
      gpuCountField,
    );
    const error = element("div", this._error, "csError");
    error.hidden = !this._error;
    this._errorNode = error;
    options.appendChild(error);
    const footer = element("div", "", "csFormFooter");
    const create = button("Create", "csPrimaryButton", () => undefined);
    create.type = "submit";
    this._create = create;
    footer.appendChild(create);
    options.appendChild(footer);
    form.appendChild(options);

    const choicesFor = (type: ResourceType): IPartitionChoice[] =>
      (this._slurm?.partitions ?? [])
        .map((item, index) => ({ key: `${type}:${index}`, partition: item }))
        .filter(({ partition: item }) => {
          const hasGpu = item.gres.some(isGpuGres);
          return type === "gpu" ? hasGpu : !hasGpu;
        });
    const selectedChoice = (): IPartitionChoice | undefined =>
      this._partitionChoices.find((item) => item.key === partition.value);
    const updateGpuCount = (): void => {
      const selected = selectedChoice()?.partition;
      const gpu = selected?.gres.find(
        (item) => gpuTypeValue(item.name) === gpuType.value,
      );
      const maximum = gpu?.count ?? 1;
      gpuCount.max = String(maximum);
      this._draft.gpuType = gpuType.value;
      this._draft.gpuCount = Math.min(
        Math.max(this._draft.gpuCount, 1),
        maximum,
      );
      gpuCount.value = String(this._draft.gpuCount);
    };
    const resetPartitionResources = (selected?: IPartition): void => {
      this._draft.cores = Math.min(1, selected?.cpuCount ?? 1);
      this._draft.memoryMb = Math.min(1024, selected?.memoryMb ?? 1024);
      this._draft.gpuType = "";
      this._draft.gpuCount = 1;
      cores.value = String(this._draft.cores);
      memory.value = String(this._draft.memoryMb);
      gpuCount.value = "1";
    };
    const updatePartition = (reset = false): void => {
      const choice = selectedChoice();
      this._draft.partitionKey = choice?.key ?? "";
      const selected = choice?.partition;
      if (reset) {
        resetPartitionResources(selected);
      }
      if (selected) {
        cores.max = String(selected.cpuCount);
        memory.max = String(selected.memoryMb);
      }
      const gpus =
        this._draft.resourceType === "gpu"
          ? (selected?.gres.filter(isGpuGres) ?? [])
          : [];
      replaceOptions(
        gpuType,
        gpus.map((item) => [gpuTypeValue(item.name), gpuTypeLabel(item.name)]),
      );
      this._draft.gpuType = gpus[0] ? gpuTypeValue(gpus[0].name) : "";
      gpuType.value = this._draft.gpuType;
      const gpuSelected = this._draft.resourceType === "gpu";
      gpuTypeField.hidden = !gpuSelected;
      gpuCountField.hidden = !gpuSelected;
      gpuType.required = gpuSelected;
      gpuCount.required = gpuSelected;
      updateGpuCount();
      this._syncStatus();
    };
    const selectResourceType = (type: ResourceType, reset = true): void => {
      this._draft.resourceType = type;
      this._partitionChoices = choicesFor(type);
      replaceOptions(
        partition,
        this._partitionChoices.map((choice) => [
          choice.key,
          partitionLabel(choice.partition),
        ]),
      );
      this._draft.partitionKey = this._partitionChoices[0]?.key ?? "";
      partition.value = this._draft.partitionKey;
      for (const input of Array.from(
        resourceChoices.querySelectorAll<HTMLInputElement>(
          'input[name="resourceType"]',
        ),
      )) {
        input.checked = input.value === type;
      }
      updatePartition(reset);
    };
    const buildResourceTypes = (): void => {
      resourceChoices.textContent = "";
      const types = (["cpu", "gpu"] as ResourceType[]).filter(
        (type) => choicesFor(type).length > 0,
      );
      for (const type of types) {
        const label = element("label", "", "csResourceTypeOption");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "resourceType";
        radio.value = type;
        radio.checked = this._draft.resourceType === type;
        radio.onchange = () => radio.checked && selectResourceType(type);
        label.append(radio, element("span", type.toUpperCase()));
        resourceChoices.appendChild(label);
      }
      const remembered = types.includes(
        this._draft.resourceType as ResourceType,
      )
        ? (this._draft.resourceType as ResourceType)
        : types.includes("cpu")
          ? "cpu"
          : types[0];
      if (!remembered) {
        throw new Error(
          `No CPU or GPU SLURM partitions were discovered for ${this._draft.sshHost}.`,
        );
      }
      selectResourceType(remembered);
      resourceType.hidden = types.length < 2;
    };
    const applyDiscovery = (value: ISlurmInfo): void => {
      this._slurm = value;
      replaceOptions(account, [
        ["", "(No allocation account)"],
        ...value.accounts.map((item) => [item, item] as [string, string]),
      ]);
      this._draft.account = value.accounts[0] ?? "";
      account.value = this._draft.account;
      buildResourceTypes();
      options.hidden = false;
      // The expanded form is the result, so the query's own progress row and any
      // login transcript that produced it retire together.
      this._stopOperation();
      consoleHost.textContent = "";
      operationArea.hidden = true;
    };
    const clearDependentState = (): void => {
      this._slurm = undefined;
      this._partitionChoices = [];
      options.hidden = true;
      resourceChoices.textContent = "";
      replaceOptions(account, []);
      replaceOptions(partition, []);
      replaceOptions(gpuType, []);
      this._syncStatus();
    };
    const current = (generation: number, alias: string): boolean =>
      generation === this._operationGeneration &&
      this._draft.sshHost === alias &&
      !this.isDisposed;
    const ensureConsole = (): ISshOperationConsole => {
      if (!this._operation) {
        this._operation = this._operationFactory();
        consoleHost.textContent = "";
        consoleHost.appendChild(this._operation.node);
      }
      return this._operation;
    };
    // A failure keeps the transcript open; a cancellation collapses it.
    const endOperation = (
      message: string,
      options: { title?: string; collapse?: boolean } = {},
    ): void => {
      if (options.title) {
        operationTitle.textContent = options.title;
      }
      retry.hidden = false;
      cancelOperation.hidden = true;
      spinner.hidden = true;
      clearDependentState();
      operationStatus.textContent = message;
      this._operation?.complete(message, options.collapse ?? true);
    };
    const showFailure = (message: string): void => {
      endOperation(message, {
        title: `SLURM discovery failed — ${this._draft.sshHost}`,
        collapse: false,
      });
      if (!this._operation) {
        this._error = message;
        this._syncStatus();
      }
    };
    const startDiscovery = (afterAuthentication = false): void => {
      const alias = this._draft.sshHost;
      const generation = ++this._operationGeneration;
      clearDependentState();
      operationTitle.textContent = "Querying SLURM…";
      operationStatus.textContent = `Connecting to ${alias}.`;
      retry.hidden = true;
      cancelOperation.hidden = false;
      spinner.hidden = false;
      const abort = new AbortController();
      this._discoveryAbort = abort;
      void this._api.discoverSlurm(alias, abort.signal).then(
        (value) => {
          if (!current(generation, alias)) {
            return;
          }
          if (value.host !== alias) {
            showFailure(
              `Received SLURM discovery for ${value.host}, not ${alias}.`,
            );
            return;
          }
          applyDiscovery(value);
        },
        (reason) => {
          if (!current(generation, alias) || abort.signal.aborted) {
            return;
          }
          if (
            !(reason instanceof ControlError) ||
            reason.code !== "ssh_authentication_required"
          ) {
            showFailure(errorMessage(reason));
            return;
          }
          if (afterAuthentication) {
            showFailure(
              `${reason.message} Authentication was already attempted; select Retry to try again.`,
            );
            return;
          }
          // The host wants an interactive login, which is the one exchange that
          // still needs a terminal. Run it, then discover again.
          operationTitle.textContent = `Interactive SSH login — ${alias}`;
          cancelOperation.hidden = false;
          const operation = ensureConsole();
          operation.start(this._api.sshAuthWebSocket(alias), {
            ready: () => {
              if (current(generation, alias)) {
                operationTitle.textContent = `SSH login ready — ${alias}`;
                startDiscovery(true);
              }
            },
            failed: (message) =>
              current(generation, alias) && showFailure(message),
          });
          requestAnimationFrame(
            () => current(generation, alias) && operation.focus(),
          );
        },
      );
    };

    retry.onclick = () => startDiscovery();
    cancelOperation.onclick = () => {
      this._operationGeneration++;
      this._discoveryAbort?.abort();
      this._operation?.cancel();
      endOperation("Operation cancelled. Select Retry to continue.");
    };
    account.onchange = () => {
      this._draft.account = account.value;
    };
    partition.onchange = () => updatePartition(true);
    gpuType.onchange = updateGpuCount;
    rootFolder.oninput = () => {
      this._draft.rootFolder = rootFolder.value;
      if (this._error) {
        this._error = "";
        this._syncStatus();
      }
    };
    for (const [control, key] of [
      [cores, "cores"],
      [memory, "memoryMb"],
      [wall, "wallMinutes"],
      [gpuCount, "gpuCount"],
    ] as Array<
      [HTMLInputElement, "cores" | "memoryMb" | "wallMinutes" | "gpuCount"]
    >) {
      control.oninput = () => {
        this._draft[key] = Number(control.value);
      };
    }

    if (this._slurm?.host === this._draft.sshHost) {
      applyDiscovery(this._slurm);
    } else if (this._draft.sshHost) {
      startDiscovery();
    }
    this._syncStatus();

    form.onsubmit = (event) => {
      event.preventDefault();
      if (!form.reportValidity() || create.disabled) {
        return;
      }
      const rootError = rootFolderValidationMessage(rootFolder.value);
      if (rootError) {
        this.setError(rootError);
        return;
      }
      const choice = selectedChoice();
      if (!choice) {
        return;
      }
      this._error = "";
      const gpu =
        this._draft.resourceType === "gpu"
          ? { gpuType: gpuType.value, gpuCount: Number(gpuCount.value) }
          : {};
      const workspace = rootFolder.value.trim();
      const resolvedRoot = resolveLinkspanRoot(
        workspace,
        this._slurm?.homeDir ?? "",
      );
      if (!resolvedRoot) {
        this.setError(
          "Workspace folder must resolve from an absolute path, ~, or $HOME for managed Jupyter.",
        );
        return;
      }
      const payload = {
        sshHost: this._draft.sshHost,
        ...(account.value ? { account: account.value } : {}),
        partition: choice.partition.name,
        rootFolder: workspace,
        resources: {
          cores: Number(cores.value),
          memoryMb: Number(memory.value),
          wallMinutes: Number(wall.value),
          ...gpu,
        },
      };
      const serialized = JSON.stringify(payload);
      if (this._payload && serialized !== this._payload) {
        this._key = crypto.randomUUID();
      }
      this._payload = serialized;
      this._cancelReviewOperation();
      const request = cloneRequest({
        idempotencyKey: this._key,
        ...payload,
      });
      this._reviewRequest = request;
      this._validation = undefined;
      this._validationError = "";
      this._render();
      void this._retryValidation();
    };
    container.appendChild(form);
    return container;
  }
}

function resolveLinkspanRoot(root: string, home: string): string | undefined {
  if (!home.startsWith("/")) return undefined;
  if (root.startsWith("/")) return root;
  if ([".", "~", "$HOME", "${HOME}"].includes(root)) return home;
  if (!root.startsWith("$") && !root.startsWith("~"))
    return `${home.replace(/\/$/, "")}/${root}`;
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) {
    if (root.startsWith(prefix))
      return `${home.replace(/\/$/, "")}/${root.slice(prefix.length)}`;
  }
  return undefined;
}

const WORKSPACE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const WORKSPACE_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function rootFolderValidationMessage(value: string): string {
  const root = value.trim();
  if (!root) {
    return "Workspace folder is required.";
  }
  if (
    root.includes("\\") ||
    root.includes("\0") ||
    root.includes("\n") ||
    root.includes("\r") ||
    root.includes("`") ||
    root.includes("$(")
  ) {
    return "Workspace folder contains unsupported shell syntax.";
  }
  if (root === "." || root === "~" || root === "$HOME" || root === "${HOME}") {
    return "";
  }
  if (root === "/") {
    return "Workspace folder cannot be the filesystem root.";
  }

  let suffix = root;
  if (root.startsWith("/")) {
    suffix = root.slice(1);
  } else if (root.startsWith("~/")) {
    suffix = root.slice(2);
  } else if (root.startsWith("$")) {
    const braced = /^\$\{([^}]+)\}(?:\/(.*))?$/.exec(root);
    const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\/(.*))?$/.exec(root);
    const variable = braced?.[1] ?? plain?.[1];
    suffix = braced?.[2] ?? plain?.[2] ?? "";
    if (!variable || !WORKSPACE_VARIABLE.test(variable)) {
      return "Workspace folder must use one environment variable at the start.";
    }
    if (variable !== "HOME") {
      return "Managed Jupyter workspace variables are limited to $HOME.";
    }
    if (suffix === "" && root.endsWith("/")) {
      return "Workspace folder contains an invalid segment.";
    }
  } else if (root.includes("$") || root.includes("~")) {
    return "Workspace folder variables and ~ are allowed only at the start.";
  }

  if (
    !suffix ||
    suffix.split("/").some((part) => {
      return (
        !part || part === "." || part === ".." || !WORKSPACE_SEGMENT.test(part)
      );
    })
  ) {
    return "Workspace folder contains an invalid segment.";
  }
  return "";
}

function cloneRequest(request: IRuntimeCreateRequest): IRuntimeCreateRequest {
  return {
    ...request,
    resources: { ...request.resources },
  };
}

function isGpuGres(item: { name: string }): boolean {
  return item.name === "gpu" || item.name.startsWith("gpu:");
}

function gpuTypeValue(name: string): string {
  return name === "gpu" ? "gpu" : name.replace(/^gpu:/, "");
}

function gpuTypeLabel(name: string): string {
  return name === "gpu" ? "Generic GPU" : name.replace(/^gpu:/, "");
}

function partitionLabel(partition: IPartition): string {
  const hardware = partition.gres
    .filter(isGpuGres)
    .map((item) => `${item.count}× ${gpuTypeLabel(item.name)}`)
    .join(", ");
  return `${partition.name} — ${partition.cpuCount} CPU · ${partition.memoryMb} MB${
    hardware ? ` · ${hardware}` : ""
  }`;
}

function input(
  name: string,
  type: string,
  placeholder: string,
): HTMLInputElement {
  const value = element("input", "", "csInput");
  value.name = name;
  value.type = type;
  value.placeholder = placeholder;
  value.required = true;
  return value;
}

function number(name: string, value: number): HTMLInputElement {
  const result = input(name, "number", "");
  result.min = "1";
  result.value = String(value);
  return result;
}

function select(
  name: string,
  options: Array<[string, string]>,
): HTMLSelectElement {
  const value = element("select", "", "csSelect");
  value.name = name;
  value.required = true;
  replaceOptions(value, options);
  return value;
}

function replaceOptions(
  control: HTMLSelectElement,
  options: Array<[string, string]>,
): void {
  control.textContent = "";
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    control.appendChild(option);
  }
}
