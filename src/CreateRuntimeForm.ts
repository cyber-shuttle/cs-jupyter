import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import {
  IPartition,
  IRuntimeCreateRequest,
  IRuntimeValidation,
  ISlurmInfo,
  ISshHost,
} from "./Common";
import { ControlClient, errorMessage, needsSshLogin } from "./ControlClient";
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

// The smallest allocation worth scheduling. cs-control enforces the same
// floor in validateCreate; keep the two in step.
const MIN_CORES = 2;
const MIN_MEMORY_MB = 4096;

interface IRuntimeDraft {
  sshHost: string;
  resourceType: ResourceType | "";
  rootFolder: string;
  wallMinutes: number;
}

function freshDraft(sshHost = ""): IRuntimeDraft {
  return { sshHost, resourceType: "", rootFolder: "", wallMinutes: 60 };
}

export class CreateRuntimeForm extends Widget {
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly createRequested = new Signal<this, IRuntimeCreateRequest>(this);
  private _hosts: ISshHost[] = [];
  private _slurm: ISlurmInfo | undefined;
  private _busy = false;
  private _error = "";
  private _key = crypto.randomUUID();
  private _payload = "";
  private _discoveryAbort: AbortController | undefined;
  private _operation: ISshOperationConsole | undefined;
  private _create: HTMLButtonElement | undefined;
  private _errorNode: HTMLElement | undefined;
  private _partition: HTMLSelectElement | undefined;
  private _partitionChoices: IPartitionChoice[] = [];
  private _draft = freshDraft();
  private _reviewRequest: IRuntimeCreateRequest | undefined;
  private _validation: IRuntimeValidation | undefined;
  private _script = "";
  private _validationError = "";
  private _validating = false;
  private _reviewAbort: AbortController | undefined;
  private _reviewSubmit: HTMLButtonElement | undefined;
  private _reviewStatus: HTMLElement | undefined;
  private _reviewError: HTMLElement | undefined;
  private _reviewSync: (() => void) | undefined;

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

  // Trade-off: setHosts is called once per form; restore compare-and-skip if
  // host polling returns.
  setHosts(hosts: ISshHost[]): void {
    this._hosts = hosts;
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

  // The dialog claims Enter for a footer this form does not have, and it claims
  // it from the document down, so the key is taken back before the dialog sees
  // it. Propagation only: the browser's own form submission is the point.
  protected onAfterAttach(): void {
    document.addEventListener("keydown", this._keepEnter, true);
  }

  protected onBeforeDetach(): void {
    document.removeEventListener("keydown", this._keepEnter, true);
  }

  private _keepEnter = (event: KeyboardEvent): void => {
    const target = event.target;
    if (
      event.key === "Enter" &&
      this.node.contains(target as Node) &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement)
    ) {
      event.stopPropagation();
    }
  };

  private _selectHost(alias: string): void {
    this._stopOperation();
    this._leaveReview();
    this._slurm = undefined;
    this._partitionChoices = [];
    this._draft = freshDraft(alias);
    this._error = "";
  }

  private _stopOperation(): void {
    this._discoveryAbort?.abort();
    this._discoveryAbort = undefined;
    this._operation?.cancel();
    this._operation?.dispose();
    this._operation = undefined;
  }

  private _cancelReviewOperation(): void {
    this._reviewAbort?.abort();
    this._reviewAbort = undefined;
    this._validating = false;
  }

  private _leaveReview(): void {
    this._cancelReviewOperation();
    this._reviewRequest = undefined;
    this._validation = undefined;
    this._script = "";
    this._validationError = "";
    this._reviewSubmit = undefined;
    this._reviewStatus = undefined;
    this._reviewError = undefined;
    this._reviewSync = undefined;
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
      const { text, modifier } = this._validationState();
      this._reviewStatus.replaceChildren(
        ...(this._validating ? [element("span", "", "csSpinner")] : []),
        document.createTextNode(text),
      );
      this._reviewStatus.className = `csValidationStatus ${modifier}`.trim();
    }
    if (this._reviewError) {
      const failed =
        !!this._error ||
        !!this._validationError ||
        this._validation?.status === "FAILED";
      const detail =
        this._error || this._validation?.stderr || this._validationError;
      this._reviewError.textContent = detail;
      this._reviewError.hidden = !detail;
      this._reviewError.className = `csValidationError${failed ? "" : " csValidationDetail"}`;
    }
    this._reviewSync?.();
  }

  private _validationState(): { text: string; modifier: string } {
    const validation = this._validation;
    if (this._validating) {
      return {
        text: "Validating with Slurm…",
        modifier: "csValidationStatusBusy",
      };
    }
    if (validation) {
      const passed = validation.status === "PASSED";
      return {
        text: `Validation ${passed ? "passed" : "failed"}. ${validation.message}`,
        modifier: passed ? "csValidationPassed" : "csValidationFailed",
      };
    }
    return {
      text: this._validationError || "Script unavailable.",
      modifier: this._validationError ? "csValidationFailed" : "",
    };
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
    this._reviewSync = undefined;
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
    // One way back, beside the action it undoes.
    const container = element("div");
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
      if (this._script) {
        void navigator.clipboard?.writeText(this._script);
      }
    });
    scriptHeader.append(scriptLabel, copy);
    const script = element("pre", "", "csSlurmScript", {
      id: "cybershuttle-slurm-script",
      tabindex: "0",
    });
    const status = element("div", "", "csValidationStatus", {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    this._reviewStatus = status;
    const validationError = element("pre", "", "csValidationError");
    this._reviewError = validationError;
    const retry = button("Retry validation", "csSecondaryButton", () => {
      void this._retryValidation();
    });
    this._reviewSync = () => {
      script.textContent = this._script;
      copy.disabled = !this._script;
      retry.hidden =
        this._validating ||
        (!this._validationError && this._validation?.status !== "FAILED");
    };

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
        this.createRequested.emit(this._reviewRequest);
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

  private async _retryValidation(): Promise<void> {
    const request = this._reviewRequest;
    if (!request || this.isDisposed) return;
    this._cancelReviewOperation();
    const abort = new AbortController();
    this._reviewAbort = abort;
    const live = (): boolean =>
      !abort.signal.aborted &&
      this._reviewRequest === request &&
      !this.isDisposed;
    this._validation = undefined;
    this._script = "";
    this._validationError = "";
    this._validating = true;
    this._syncStatus();
    try {
      const validation = await this._api.validateRuntime(request, abort.signal);
      if (live()) {
        this._validation = validation;
        this._script = validation.script;
      }
    } catch (error) {
      if (live()) {
        this._validationError = errorMessage(error);
      }
    }
    if (live()) {
      this._validating = false;
      this._reviewAbort = undefined;
      this._syncStatus();
    }
  }

  private _buildConfigurationStep(): HTMLElement {
    const container = element("div");
    const form = element("form", "", "csForm");

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
    const operationTitle = element("strong", "Slurm discovery");
    const cancelOperation = button(
      "Cancel",
      "csTextButton csDiscoveryCancel",
      () => undefined,
    );
    cancelOperation.hidden = true;
    operationHeader.append(spinner, operationTitle, cancelOperation);
    // Discovery is a plain request, so its outcome has to be readable here.
    // The console below only ever holds an interactive login transcript.
    const operationStatus = element("div", "", "csSshAuthStatus", {
      role: "status",
    });
    const consoleHost = element("div", "", "csSshAuthHost");
    const retry = button("Retry", "csSecondaryButton", () => undefined);
    retry.hidden = true;
    operationArea.append(operationHeader, operationStatus, consoleHost, retry);
    form.appendChild(operationArea);

    const options = element("div", "", "csRuntimeOptions");
    options.hidden = true;
    const resourceType = element("fieldset", "", "csResourceType");
    const resourceLegend = element("legend", "Resource type", "csLabel");
    const resourceChoices = element("div", "", "csResourceTypeChoices");
    resourceType.append(resourceLegend, resourceChoices);
    const account = select("account", [], false);
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
      { id: "cybershuttle-workspace-help" },
    );
    rootFolder.setAttribute("aria-describedby", workspaceHelp.id);
    const workspaceField = field("Workspace folder", rootFolder);
    workspaceField.appendChild(workspaceHelp);
    const cores = number("cores", MIN_CORES, MIN_CORES);
    const memory = number("memoryMb", MIN_MEMORY_MB, MIN_MEMORY_MB);
    const wall = number("wallMinutes", this._draft.wallMinutes);
    const gpuType = select("gpuType", []);
    const gpuCount = number("gpuCount", 1);
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
      gpuCount.value = String(
        Math.min(Math.max(Number(gpuCount.value) || 1, 1), maximum),
      );
    };
    const resetPartitionResources = (selected?: IPartition): void => {
      cores.value = String(
        Math.min(MIN_CORES, selected?.cpuCount ?? MIN_CORES),
      );
      memory.value = String(
        Math.min(MIN_MEMORY_MB, selected?.memoryMb ?? MIN_MEMORY_MB),
      );
      gpuCount.value = "1";
    };
    const updatePartition = (reset = false): void => {
      const selected = selectedChoice()?.partition;
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
      fillOptions(
        gpuType,
        gpus.map((item): [string, string] => [
          gpuTypeValue(item.name),
          gpuTypeLabel(item.name),
        ]),
      );
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
      fillOptions(
        partition,
        this._partitionChoices.map((choice): [string, string] => [
          choice.key,
          partitionLabel(choice.partition),
        ]),
      );
      updatePartition(reset);
    };
    const buildResourceTypes = (): void => {
      resourceChoices.textContent = "";
      const types = (["cpu", "gpu"] as ResourceType[]).filter(
        (type) => choicesFor(type).length > 0,
      );
      const remembered = types.includes(
        this._draft.resourceType as ResourceType,
      )
        ? (this._draft.resourceType as ResourceType)
        : types.includes("cpu")
          ? "cpu"
          : types[0];
      if (!remembered) {
        throw new Error(
          `No CPU or GPU Slurm partitions were discovered for ${this._draft.sshHost}.`,
        );
      }
      for (const type of types) {
        const label = element("label", "", "csResourceTypeOption");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "resourceType";
        radio.value = type;
        radio.checked = type === remembered;
        radio.onchange = () => radio.checked && selectResourceType(type);
        label.append(radio, element("span", type.toUpperCase()));
        resourceChoices.appendChild(label);
      }
      selectResourceType(remembered);
      resourceType.hidden = types.length < 2;
    };
    const applyDiscovery = (value: ISlurmInfo): void => {
      this._slurm = value;
      fillOptions(
        account,
        [
          ["", "(No allocation account)"],
          ...value.accounts.map((item): [string, string] => [item, item]),
        ],
        value.accounts[0] ?? "",
      );
      buildResourceTypes();
      options.hidden = false;
      // The expanded form is the result, so the query's own progress row and any
      // login transcript that produced it retire together.
      this._stopOperation();
      consoleHost.textContent = "";
      operationArea.hidden = true;
    };
    // The options are refilled before they are shown again, so hiding them is
    // the whole reset.
    const clearDependentState = (): void => {
      this._slurm = undefined;
      this._partitionChoices = [];
      options.hidden = true;
      this._syncStatus();
    };
    const running = (on: boolean): void => {
      retry.hidden = on;
      cancelOperation.hidden = spinner.hidden = !on;
    };
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
      running(false);
      clearDependentState();
      operationStatus.textContent = message;
      this._operation?.complete(message, options.collapse ?? true);
    };
    const showFailure = (message: string): void => {
      endOperation(message, {
        title: `Slurm discovery failed — ${this._draft.sshHost}`,
        collapse: false,
      });
      if (!this._operation) {
        this._error = message;
        this._syncStatus();
      }
    };
    const startDiscovery = (afterAuthentication = false): void => {
      const alias = this._draft.sshHost;
      clearDependentState();
      operationTitle.textContent = "Querying Slurm…";
      operationStatus.textContent = `Connecting to ${alias}.`;
      running(true);
      this._discoveryAbort?.abort();
      const abort = new AbortController();
      this._discoveryAbort = abort;
      const current = (): boolean =>
        !abort.signal.aborted &&
        this._draft.sshHost === alias &&
        !this.isDisposed;
      void this._api.discoverSlurm(alias, abort.signal).then(
        (value) => {
          if (!current()) {
            return;
          }
          if (value.host !== alias) {
            showFailure(
              `Received Slurm discovery for ${value.host}, not ${alias}.`,
            );
            return;
          }
          applyDiscovery(value);
        },
        (reason) => {
          if (!current()) {
            return;
          }
          if (!needsSshLogin(reason)) {
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
              if (current()) {
                operationTitle.textContent = `SSH login ready — ${alias}`;
                startDiscovery(true);
              }
            },
            failed: (message) => current() && showFailure(message),
            status: (message) => {
              if (current()) {
                operationStatus.textContent = message;
              }
            },
          });
          requestAnimationFrame(() => current() && operation.focus());
        },
      );
    };

    retry.onclick = () => startDiscovery();
    cancelOperation.onclick = () => {
      this._stopOperation();
      endOperation("Operation cancelled. Select Retry to continue.");
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
    wall.oninput = () => (this._draft.wallMinutes = Number(wall.value));

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
      const choice = selectedChoice();
      if (!choice) {
        return;
      }
      this._error = "";
      const gpu =
        this._draft.resourceType === "gpu"
          ? { gpuType: gpuType.value, gpuCount: Number(gpuCount.value) }
          : {};
      const payload = {
        sshHost: this._draft.sshHost,
        ...(account.value ? { account: account.value } : {}),
        partition: choice.partition.name,
        rootFolder: rootFolder.value.trim(),
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
      // Trade-off: requests are treated as immutable; clone if a consumer ever
      // edits one in place.
      this._reviewRequest = { idempotencyKey: this._key, ...payload };
      this._validation = undefined;
      this._validationError = "";
      this._render();
      void this._retryValidation();
    };
    container.appendChild(form);
    return container;
  }
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

function number(name: string, value: number, min = 1): HTMLInputElement {
  const result = input(name, "number", "");
  result.min = String(min);
  result.value = String(value);
  return result;
}

function select(
  name: string,
  options: Array<[string, string]>,
  required = true,
): HTMLSelectElement {
  const value = element("select", "", "csSelect");
  value.name = name;
  value.required = required;
  fillOptions(value, options);
  return value;
}

function fillOptions(
  control: HTMLSelectElement,
  options: Array<[string, string]>,
  chosen = options[0]?.[0] ?? "",
): void {
  control.replaceChildren(
    ...options.map(([value, label]) => new Option(label, value)),
  );
  control.value = chosen;
}
