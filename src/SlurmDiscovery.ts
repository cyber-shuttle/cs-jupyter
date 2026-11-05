// Picks a compute host and an application on its cluster, and discovers its
// Slurm accounts and partitions. Host switches and cancellation invalidate the
// in-flight discovery.
import {
  clusterLabel,
  configLogin,
  configName,
  errorMessage,
  IDeployment,
  ISlurmInfo,
  type Schemas,
} from "./Common";
import { PlaneClient } from "./PlaneClient";
import { button, element, field, fillOptions, select } from "./dom";

interface ISlurmDiscoveryHooks {
  onClusterChange: (clusterId: string) => void;
  onDiscovered: () => void;
  onCleared: () => void;
  onError: (message: string) => void;
  isDisposed: () => boolean;
}

export class SlurmDiscovery {
  private _clusters: Schemas["SlurmClusterConfigResponse"][] = [];
  private _deployments: IDeployment[] = [];
  slurm: ISlurmInfo | undefined;
  clusterId = "";
  deploymentId = "";
  preferredAccount: string | undefined;
  private _discoveryAbort: AbortController | undefined;
  account!: HTMLSelectElement;
  accountField!: HTMLElement;

  constructor(private _api: PlaneClient) {}

  setClusters(
    clusters: Schemas["SlurmClusterConfigResponse"][],
    deployments: IDeployment[],
  ): void {
    this._clusters = clusters;
    this._deployments = deployments;
  }

  get deployments(): IDeployment[] {
    const cluster = this._clusters.find(
      (each) => each.slurmClusterConfigId === this.clusterId,
    );
    return this._deployments.filter(
      (each) => cluster && each.slurmClusterId === cluster.slurmClusterId,
    );
  }

  get label(): string {
    return clusterLabel(this._clusters, this.clusterId);
  }

  selectCluster(clusterId: string): void {
    this.stop();
    this.clusterId = clusterId;
    this.deploymentId = this.deployments[0]?.deploymentId ?? "";
    this.slurm = undefined;
  }

  stop(): void {
    this._discoveryAbort?.abort();
    this._discoveryAbort = undefined;
  }

  build(hooks: ISlurmDiscoveryHooks): HTMLElement {
    const container = element("div");

    const cluster = select("clusterId", [
      ["", "Select a compute host…"],
      ...this._clusters.map((each): [string, string] => [
        each.slurmClusterConfigId,
        `${configName(each)} (${configLogin(each)})`,
      ]),
    ]);
    cluster.value = this.clusterId;
    cluster.onchange = () => hooks.onClusterChange(cluster.value);
    container.appendChild(field("Compute host", cluster));

    if (this.clusterId) {
      const deployments = this.deployments.map((each): [string, string] => [
        each.deploymentId,
        each.name,
      ]);
      const application = select(
        "deploymentId",
        deployments.length
          ? deployments
          : [["", "None deployed here; an administrator must add one."]],
      );
      application.value = this.deploymentId;
      application.onchange = () => (this.deploymentId = application.value);
      container.appendChild(field("Application", application));
    }

    this.account = select("account", []);
    this.accountField = field("Slurm account", this.account);

    const operationArea = element("section", "", "csSshAuth");
    operationArea.hidden = !this.clusterId;
    const operationHeader = element("div", "", "csSshAuthHeader");
    const spinner = element("span", "", "csSpinner");
    const operationTitle = element("strong", "Slurm discovery");
    const cancelOperation = button("Cancel", "csTextButton csDiscoveryCancel");
    operationHeader.append(spinner, operationTitle, cancelOperation);
    const operationStatus = element("div", "", "csSshAuthStatus", {
      role: "status",
    });
    const retry = button("Retry", "csSecondaryButton");
    operationArea.append(operationHeader, operationStatus, retry);
    container.appendChild(operationArea);

    const renderPhase = (
      title: string | undefined,
      status: string | undefined,
      running: boolean,
    ): void => {
      if (title !== undefined) operationTitle.textContent = title;
      if (status !== undefined) operationStatus.textContent = status;
      retry.hidden = running;
      cancelOperation.hidden = spinner.hidden = !running;
    };
    const clearDependentState = (): void => {
      this.slurm = undefined;
      hooks.onCleared();
    };
    const endOperation = (message: string, title?: string): void => {
      renderPhase(title, message, false);
      clearDependentState();
    };
    const showFailure = (message: string): void => {
      endOperation(message, `Slurm discovery failed — ${this.label}`);
      hooks.onError(message);
    };
    const applyDiscovery = (value: ISlurmInfo): void => {
      this.slurm = value;
      const preferred = this.preferredAccount;
      fillOptions(
        this.account,
        value.accounts.map((item): [string, string] => [item, item]),
        preferred && value.accounts.includes(preferred) ? preferred : undefined,
      );
      hooks.onDiscovered();
      this.stop();
      operationArea.hidden = true;
    };
    const startDiscovery = async (): Promise<void> => {
      const clusterId = this.clusterId;
      clearDependentState();
      renderPhase("Querying Slurm…", `Connecting to ${this.label}.`, true);
      this._discoveryAbort?.abort();
      const abort = new AbortController();
      this._discoveryAbort = abort;
      const current = (): boolean =>
        !abort.signal.aborted &&
        this.clusterId === clusterId &&
        !hooks.isDisposed();
      try {
        const value = await this._api.discoverSlurm(clusterId, abort.signal);
        if (current()) {
          applyDiscovery(value);
        }
      } catch (error) {
        if (current()) {
          showFailure(errorMessage(error));
        }
      }
    };

    retry.onclick = () => startDiscovery();
    cancelOperation.onclick = () => {
      this.stop();
      endOperation("Operation cancelled. Select Retry to continue.");
    };

    if (this.slurm?.configId === this.clusterId) {
      applyDiscovery(this.slurm);
    } else if (this.clusterId) {
      startDiscovery();
    }

    return container;
  }
}
