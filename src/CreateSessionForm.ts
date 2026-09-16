// The Add Session wizard shell: step navigation and shared error and busy state.
// Host discovery, partition and GPU choices, and the final submit step live in
// their own modules. A document-level keydown listener retakes Enter so the
// dialog chrome cannot swallow it before submit.
import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import { IPartition, ISessionCreateRequest, ISshHost } from "./Common";
import { ControlClient } from "./ControlClient";
import { SshOperationConsoleFactory } from "./SshOperationConsole";
import { button, element, field, fillOptions, select } from "./dom";
import {
  availableResourceTypes,
  gpuMax,
  gpuOptions,
  IPartitionChoice,
  MAX_WALL_MINUTES,
  MIN_CORES,
  MIN_MEMORY_MB,
  partitionChoices,
  partitionLabel,
  ResourceType,
} from "./PartitionModel";
import { ReviewStep, type IReviewStepHooks } from "./ReviewStep";
import { SlurmDiscovery } from "./SlurmDiscovery";

interface ISessionDraft {
  resourceType: ResourceType | "";
  rootFolder: string;
  wallMinutes: number;
  partitionKey: string;
  cores: number;
  memoryMb: number;
  gpuType: string;
  gpuCount: number;
  account: string | undefined;
}

function freshDraft(): ISessionDraft {
  return {
    resourceType: "",
    rootFolder: "",
    wallMinutes: 60,
    partitionKey: "",
    cores: MIN_CORES,
    memoryMb: MIN_MEMORY_MB,
    gpuType: "",
    gpuCount: 1,
    account: undefined,
  };
}

export class CreateSessionForm extends Widget {
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly createRequested = new Signal<this, ISessionCreateRequest>(this);
  private _busy = false;
  private _error = "";
  private _key = crypto.randomUUID();
  private _payload = "";
  private _create: HTMLButtonElement | undefined;
  private _errorNode: HTMLElement | undefined;
  private _partition: HTMLSelectElement | undefined;
  private _partitionChoices: IPartitionChoice[] = [];
  private _draft = freshDraft();
  private _discovery: SlurmDiscovery;
  private _review: ReviewStep;

  constructor(
    private _api: ControlClient,
    operationFactory?: SshOperationConsoleFactory,
  ) {
    super();
    this.id = "cybershuttle-create-session";
    this.addClass("csSessionPanel");
    this.hide();
    this._discovery = new SlurmDiscovery(this._api, operationFactory);
    this._review = new ReviewStep(this._api);
    this._render();
  }

  setHosts(hosts: ISshHost[]): void {
    this._discovery.setHosts(hosts);
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

  dispose(): void {
    this._discovery.dispose();
    this._review.cancel();
    super.dispose();
  }

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
    this._discovery.selectHost(alias);
    this._review.leave();
    this._partitionChoices = [];
    this._draft = freshDraft();
    this._error = "";
  }

  private _syncStatus(): void {
    if (this._create) {
      const selected = this._partitionChoices.find(
        (item) => item.key === this._partition?.value,
      );
      this._create.disabled = !selected;
    }
    if (this._errorNode) {
      this._errorNode.textContent = this._error;
      this._errorNode.hidden = !this._error;
    }
    this._review.sync(this._busy, this._error);
  }

  private _render(): void {
    this._discovery.stop();
    this.node.textContent = "";
    this._create = undefined;
    this._errorNode = undefined;
    this._partition = undefined;
    const root = element("div", "", "csRoot");
    root.append(
      element("hr", "", "csModalRule"),
      this._review.isActive
        ? this._buildReviewStep()
        : this._buildConfigurationStep(),
    );
    this.node.appendChild(root);
  }

  private _reviewHooks(): IReviewStepHooks {
    return {
      onBack: () => {
        this._review.leave();
        this._render();
      },
      onSubmit: (request) => this.createRequested.emit(request),
      isDisposed: () => this.isDisposed,
      onChange: () => this._syncStatus(),
    };
  }

  private _buildReviewStep(): HTMLElement {
    const node = this._review.build(this._reviewHooks());
    this._syncStatus();
    return node;
  }

  private _buildConfigurationStep(): HTMLElement {
    const form = element("form", "", "csForm");

    const options = element("div", "", "csSessionOptions");
    options.hidden = true;
    const resourceType = element("fieldset", "", "csResourceType");
    const resourceLegend = element("legend", "Resource type", "csLabel");
    const resourceChoices = element("div", "", "csResourceTypeChoices");
    resourceType.append(resourceLegend, resourceChoices);
    const partition = select("partition", []);
    this._partition = partition;
    const rootFolder = input("rootFolder", "text");
    rootFolder.value = this._draft.rootFolder;
    const workspaceHelp = element(
      "div",
      workspaceHelpText(this._discovery.slurm?.homeDir),
      "csFieldHelp",
      { id: "cybershuttle-workspace-help" },
    );
    rootFolder.setAttribute("aria-describedby", workspaceHelp.id);
    const workspaceField = field("Workspace folder", rootFolder);
    workspaceField.appendChild(workspaceHelp);
    const cores = number("cores", MIN_CORES, MIN_CORES);
    const memory = number("memoryMb", MIN_MEMORY_MB, MIN_MEMORY_MB);
    const wall = number("wallMinutes", this._draft.wallMinutes);
    wall.max = String(MAX_WALL_MINUTES);
    const gpuType = select("gpuType", []);
    const gpuCount = number("gpuCount", 1);
    const gpuTypeField = field("GPU type", gpuType);
    const gpuCountField = field("GPUs", gpuCount);
    const error = element("div", this._error, "csError");
    error.hidden = !this._error;
    this._errorNode = error;
    const footer = element("div", "", "csFormFooter");
    const create = button("Review", "csPrimaryButton");
    create.type = "submit";
    this._create = create;
    footer.appendChild(create);

    const selectedChoice = (): IPartitionChoice | undefined =>
      this._partitionChoices.find((item) => item.key === partition.value);
    const updateGpuCount = (): void => {
      const selected = selectedChoice()?.partition;
      const maximum = gpuMax(selected, gpuType.value);
      gpuCount.max = String(maximum);
      gpuCount.value = String(
        Math.min(Math.max(Number(gpuCount.value) || 1, 1), maximum),
      );
      this._draft.gpuType = gpuType.value;
      this._draft.gpuCount = Number(gpuCount.value);
    };
    const resetPartitionResources = (selected?: IPartition): void => {
      const restoring =
        this._draft.partitionKey !== "" &&
        partition.value === this._draft.partitionKey;
      cores.value = String(
        restoring
          ? Math.min(this._draft.cores, selected?.cpuCount ?? MIN_CORES)
          : Math.min(MIN_CORES, selected?.cpuCount ?? MIN_CORES),
      );
      memory.value = String(
        restoring
          ? Math.min(this._draft.memoryMb, selected?.memoryMb ?? MIN_MEMORY_MB)
          : Math.min(MIN_MEMORY_MB, selected?.memoryMb ?? MIN_MEMORY_MB),
      );
      gpuCount.value = restoring ? String(this._draft.gpuCount) : "1";
      this._draft.partitionKey = partition.value;
      this._draft.cores = Number(cores.value);
      this._draft.memoryMb = Number(memory.value);
      this._draft.gpuCount = Number(gpuCount.value);
    };
    const updatePartition = (): void => {
      const selected = selectedChoice()?.partition;
      resetPartitionResources(selected);
      if (selected) {
        cores.max = String(selected.cpuCount);
        memory.max = String(selected.memoryMb);
      }
      const gpus =
        this._draft.resourceType === "gpu" ? gpuOptions(selected) : [];
      const rememberedGpuType = gpus.some(
        ([key]) => key === this._draft.gpuType,
      )
        ? this._draft.gpuType
        : undefined;
      fillOptions(gpuType, gpus, rememberedGpuType);
      const gpuSelected = this._draft.resourceType === "gpu";
      gpuTypeField.hidden = !gpuSelected;
      gpuCountField.hidden = !gpuSelected;
      gpuType.required = gpuSelected;
      gpuCount.required = gpuSelected;
      updateGpuCount();
      this._syncStatus();
    };
    const selectResourceType = (type: ResourceType): void => {
      this._draft.resourceType = type;
      this._partitionChoices = partitionChoices(
        this._discovery.slurm?.partitions ?? [],
        type,
      );
      const choices = this._partitionChoices.map((choice): [string, string] => [
        choice.key,
        partitionLabel(choice.partition),
      ]);
      const remembered = choices.some(
        ([key]) => key === this._draft.partitionKey,
      )
        ? this._draft.partitionKey
        : undefined;
      fillOptions(partition, choices, remembered);
      updatePartition();
    };
    const buildResourceTypes = (): boolean => {
      resourceChoices.textContent = "";
      const partitions = this._discovery.slurm?.partitions ?? [];
      const types = availableResourceTypes(partitions);
      const remembered = types.includes(
        this._draft.resourceType as ResourceType,
      )
        ? (this._draft.resourceType as ResourceType)
        : types.includes("cpu")
          ? "cpu"
          : types[0];
      if (!remembered) {
        this._error = `No CPU or GPU Slurm partitions were discovered for ${this._discovery.sshHost}.`;
        this._syncStatus();
        return false;
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
      return true;
    };

    partition.onchange = () => updatePartition();
    gpuType.onchange = updateGpuCount;
    rootFolder.oninput = () => {
      this._draft.rootFolder = rootFolder.value;
      if (this._error) {
        this._error = "";
        this._syncStatus();
      }
    };
    wall.oninput = () => (this._draft.wallMinutes = Number(wall.value));
    cores.oninput = () => (this._draft.cores = Number(cores.value));
    memory.oninput = () => (this._draft.memoryMb = Number(memory.value));
    gpuCount.oninput = () => (this._draft.gpuCount = Number(gpuCount.value));

    this._discovery.preferredAccount = this._draft.account;
    const discoveryNode = this._discovery.build({
      onManageHosts: () => this.sshHostsRequested.emit(undefined),
      onHostChange: (alias) => {
        this._selectHost(alias);
        this._render();
      },
      onDiscovered: () => {
        workspaceHelp.textContent = workspaceHelpText(
          this._discovery.slurm?.homeDir,
        );
        options.hidden = !buildResourceTypes();
      },
      onCleared: () => {
        this._partitionChoices = [];
        options.hidden = true;
        workspaceHelp.textContent = workspaceHelpText(undefined);
        this._syncStatus();
      },
      onError: (message) => {
        this._error = message;
        this._syncStatus();
      },
      isDisposed: () => this.isDisposed,
    });
    this._discovery.account.onchange = () =>
      (this._draft.account = this._discovery.account.value);
    form.appendChild(discoveryNode);
    options.append(
      resourceType,
      this._discovery.accountField,
      field("Partition", partition),
      workspaceField,
      field("Cores", cores),
      field("Memory (MB)", memory),
      field("Walltime (minutes)", wall),
      gpuTypeField,
      gpuCountField,
      error,
      footer,
    );
    form.appendChild(options);
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
        sshHost: this._discovery.sshHost,
        ...(this._discovery.account.value
          ? { account: this._discovery.account.value }
          : {}),
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
      this._review.start({ idempotencyKey: this._key, ...payload });
      this._render();
      void this._review.validate(this._reviewHooks());
    };
    return form;
  }
}

function workspaceHelpText(homeDir: string | undefined): string {
  return homeDir
    ? `Relative to ${homeDir} unless it starts with /, ~ or $.`
    : "Examples: . \u00b7 ~/cybershuttle \u00b7 $HOME/work \u00b7 /scratch/user/work";
}

function input(name: string, type: string): HTMLInputElement {
  const value = element("input", "", "csInput");
  value.name = name;
  value.type = type;
  value.required = true;
  return value;
}

function number(name: string, value: number, min = 1): HTMLInputElement {
  const result = input(name, "number");
  result.min = String(min);
  result.value = String(value);
  return result;
}
