// Picks an SSH host and discovers its Slurm accounts and partitions. The
// shared login dock owns every interactive SSH exchange; discovery awaits that
// operation and retries once. Host switches and cancellation invalidate the
// in-flight discovery without taking ownership of the shared dock.
import { errorMessage, ISlurmInfo, ISshHost } from "./Common";
import { ControlClient, needsSshLogin } from "./ControlClient";
import type { SshLoginDock } from "./ssh";
import { button, element, field, fillOptions, select } from "./dom";

interface ISlurmDiscoveryHooks {
  onManageHosts: () => void;
  onHostChange: (alias: string) => void;
  onDiscovered: () => void;
  onCleared: () => void;
  onError: (message: string) => void;
  isDisposed: () => boolean;
}

export class SlurmDiscovery {
  private _hosts: ISshHost[] = [];
  slurm: ISlurmInfo | undefined;
  sshHost = "";
  preferredAccount: string | undefined;
  private _discoveryAbort: AbortController | undefined;
  account!: HTMLSelectElement;
  accountField!: HTMLElement;

  constructor(
    private _api: ControlClient,
    private _loginDock: () => SshLoginDock,
  ) {}

  setHosts(hosts: ISshHost[]): void {
    this._hosts = hosts;
  }

  selectHost(alias: string): void {
    this.stop();
    this.sshHost = alias;
    this.slurm = undefined;
  }

  stop(): void {
    this._discoveryAbort?.abort();
    this._discoveryAbort = undefined;
  }

  build(hooks: ISlurmDiscoveryHooks): HTMLElement {
    const container = element("div");

    const host = select("sshHost", [
      [
        "",
        this._hosts.length ? "Select a host…" : "No SSH hosts are configured.",
      ],
      ...this._hosts.map((item) => [item.name, item.name] as [string, string]),
    ]);
    host.value = this.sshHost;
    host.disabled = !this._hosts.length;
    host.onchange = () => hooks.onHostChange(host.value);
    container.appendChild(field("SSH Host", host));
    if (!this._hosts.length) {
      container.appendChild(
        button("Manage SSH hosts", "csTextButton", hooks.onManageHosts),
      );
    }

    this.account = select("account", [], false);
    this.accountField = field("Slurm account", this.account);

    const operationArea = element("section", "", "csSshAuth");
    operationArea.hidden = !this.sshHost;
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
      endOperation(message, `Slurm discovery failed — ${this.sshHost}`);
      hooks.onError(message);
    };
    const applyDiscovery = (value: ISlurmInfo): void => {
      this.slurm = value;
      const preferred = this.preferredAccount;
      const chosen =
        preferred === "" || (preferred && value.accounts.includes(preferred))
          ? preferred
          : (value.accounts[0] ?? "");
      fillOptions(
        this.account,
        [
          ["", "(no Slurm account)"],
          ...value.accounts.map((item): [string, string] => [item, item]),
        ],
        chosen,
      );
      hooks.onDiscovered();
      this.stop();
      operationArea.hidden = true;
    };
    const startDiscovery = async (allowLogin = true): Promise<void> => {
      const alias = this.sshHost;
      clearDependentState();
      renderPhase("Querying Slurm…", `Connecting to ${alias}.`, true);
      this._discoveryAbort?.abort();
      const abort = new AbortController();
      this._discoveryAbort = abort;
      const current = (): boolean =>
        !abort.signal.aborted && this.sshHost === alias && !hooks.isDisposed();
      try {
        const value = await this._api.discoverSlurm(alias, abort.signal);
        if (current()) {
          applyDiscovery(value);
        }
      } catch (error) {
        if (!current()) {
          return;
        }
        if (!needsSshLogin(error)) {
          showFailure(errorMessage(error));
          return;
        }
        if (!allowLogin) {
          showFailure(
            `${errorMessage(error)} Authentication was already attempted; select Retry to try again.`,
          );
          return;
        }
        renderPhase(`Interactive SSH login — ${alias}`, undefined, true);
        try {
          await this._loginDock().login(
            alias,
            this._api.sshAuthWebSocket(alias),
          );
        } catch (loginError) {
          if (current()) {
            showFailure(errorMessage(loginError));
          }
          return;
        }
        if (current()) {
          await startDiscovery(false);
        }
      }
    };

    retry.onclick = () => startDiscovery();
    cancelOperation.onclick = () => {
      this.stop();
      endOperation("Operation cancelled. Select Retry to continue.");
    };

    if (this.slurm?.host === this.sshHost) {
      applyDiscovery(this.slurm);
    } else if (this.sshHost) {
      startDiscovery();
    }

    return container;
  }
}
