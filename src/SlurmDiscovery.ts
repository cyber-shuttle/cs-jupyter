// Picks an SSH host and discovers its Slurm accounts and partitions, including
// any interactive login needed. It owns the host and account select elements;
// the caller places them and reacts to its callbacks. The console area holds
// only an interactive login transcript, staying open on failure and closing
// once discovery succeeds. Operation-area state (title, status text and the
// spinner/cancel/retry visibility) is rendered from one phase record instead
// of being poked at from every call site.
import { errorMessage, ISlurmInfo, ISshHost } from "./Common";
import { ControlClient, needsSshLogin } from "./ControlClient";
import {
  ISshOperationConsole,
  SshOperationConsole,
  SshOperationConsoleFactory,
} from "./ssh";
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
  private _slurm: ISlurmInfo | undefined;
  private _sshHost = "";
  preferredAccount: string | undefined;
  private _discoveryAbort: AbortController | undefined;
  private _operation: ISshOperationConsole | undefined;
  private _account!: HTMLSelectElement;
  private _accountField!: HTMLElement;

  constructor(
    private _api: ControlClient,
    private _operationFactory: SshOperationConsoleFactory = () =>
      new SshOperationConsole(),
  ) {}

  get sshHost(): string {
    return this._sshHost;
  }

  get slurm(): ISlurmInfo | undefined {
    return this._slurm;
  }

  get account(): HTMLSelectElement {
    return this._account;
  }

  get accountField(): HTMLElement {
    return this._accountField;
  }

  setHosts(hosts: ISshHost[]): void {
    this._hosts = hosts;
  }

  selectHost(alias: string): void {
    this.stop();
    this._sshHost = alias;
    this._slurm = undefined;
  }

  stop(): void {
    this._discoveryAbort?.abort();
    this._discoveryAbort = undefined;
    this._operation?.dispose();
    this._operation = undefined;
  }

  dispose(): void {
    this.stop();
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
    host.value = this._sshHost;
    host.required = true;
    host.disabled = !this._hosts.length;
    host.onchange = () => hooks.onHostChange(host.value);
    container.appendChild(field("SSH Host", host));
    if (!this._hosts.length) {
      container.appendChild(
        button("Manage SSH hosts", "csTextButton", hooks.onManageHosts),
      );
    }

    this._account = select("account", [], false);
    this._accountField = field("Slurm account", this._account);

    const operationArea = element("section", "", "csSshAuth");
    operationArea.hidden = !this._sshHost;
    const operationHeader = element("div", "", "csSshAuthHeader");
    const spinner = element("span", "", "csSpinner");
    const operationTitle = element("strong", "Slurm discovery");
    const cancelOperation = button("Cancel", "csTextButton csDiscoveryCancel");
    operationHeader.append(spinner, operationTitle, cancelOperation);
    const operationStatus = element("div", "", "csSshAuthStatus", {
      role: "status",
    });
    const consoleHost = element("div");
    const retry = button("Retry", "csSecondaryButton");
    operationArea.append(operationHeader, operationStatus, consoleHost, retry);
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
    const ensureConsole = (): ISshOperationConsole => {
      if (!this._operation) {
        this._operation = this._operationFactory();
        consoleHost.textContent = "";
        consoleHost.appendChild(this._operation.node);
      }
      return this._operation;
    };
    const clearDependentState = (): void => {
      this._slurm = undefined;
      hooks.onCleared();
    };
    const endOperation = (message: string, title?: string): void => {
      renderPhase(title, message, false);
      clearDependentState();
      this._operation?.complete(message, !title);
    };
    const showFailure = (message: string): void => {
      endOperation(message, `Slurm discovery failed — ${this._sshHost}`);
      if (!this._operation) {
        hooks.onError(message);
      }
    };
    const applyDiscovery = (value: ISlurmInfo): void => {
      this._slurm = value;
      const preferred = this.preferredAccount;
      const chosen =
        preferred === "" || (preferred && value.accounts.includes(preferred))
          ? preferred
          : (value.accounts[0] ?? "");
      fillOptions(
        this._account,
        [
          ["", "(no Slurm account)"],
          ...value.accounts.map((item): [string, string] => [item, item]),
        ],
        chosen,
      );
      hooks.onDiscovered();
      this.stop();
      consoleHost.textContent = "";
      operationArea.hidden = true;
    };
    const startDiscovery = (afterAuthentication = false): void => {
      const alias = this._sshHost;
      clearDependentState();
      renderPhase("Querying Slurm…", `Connecting to ${alias}.`, true);
      this._discoveryAbort?.abort();
      const abort = new AbortController();
      this._discoveryAbort = abort;
      const current = (): boolean =>
        !abort.signal.aborted && this._sshHost === alias && !hooks.isDisposed();
      void this._api.discoverSlurm(alias, abort.signal).then(
        (value) => {
          if (!current()) {
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
          renderPhase(`Interactive SSH login — ${alias}`, undefined, true);
          const operation = ensureConsole();
          operation.start(this._api.sshAuthWebSocket(alias), {
            ready: () => {
              if (current()) {
                operation.complete(`Signed in to ${alias}.`);
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
      this.stop();
      endOperation("Operation cancelled. Select Retry to continue.");
    };

    if (this._slurm?.host === this._sshHost) {
      applyDiscovery(this._slurm);
    } else if (this._sshHost) {
      startDiscovery();
    }

    return container;
  }
}
