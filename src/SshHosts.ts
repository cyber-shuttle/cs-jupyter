import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import { ISshHost } from "./Common";
import { ControlClient, errorMessage } from "./ControlClient";
import { button, element } from "./dom";

export class SshHosts extends Widget {
  readonly backRequested = new Signal<this, void>(this);
  private _api: ControlClient;
  private _hosts: ISshHost[] = [];
  private _busy = false;
  private _error = "";

  constructor(api: ControlClient) {
    super();
    this._api = api;
    this.id = "cybershuttle-ssh-hosts";
    this.addClass("csRuntimePanel");
    this.hide();
    this._render();
  }

  async refresh(): Promise<void> {
    this._busy = true;
    this._error = "";
    this._render();
    try {
      const hosts = await this._api.listSshHosts();
      if (!this.isDisposed) {
        this._hosts = hosts;
      }
    } catch (error) {
      if (!this.isDisposed) {
        this._error = errorMessage(error);
      }
    } finally {
      if (!this.isDisposed) {
        this._busy = false;
        this._render();
      }
    }
  }

  private _render(): void {
    this.node.textContent = "";
    const root = document.createElement("div");
    root.className = "csRoot";
    const top = document.createElement("div");
    top.className = "csFormTop";
    top.appendChild(
      button("← Back", "csTextButton", () =>
        this.backRequested.emit(undefined),
      ),
    );
    top.appendChild(element("div", "SSH Hosts", "csFormTitle"));
    root.appendChild(top);
    root.appendChild(
      element(
        "div",
        "Hosts come from your SSH configuration. Edit ~/.ssh/config to add or change one.",
        "csStatus",
      ),
    );
    if (this._error) {
      root.appendChild(element("div", this._error, "csError"));
    }
    const card = document.createElement("div");
    card.className = "csCard";
    for (const host of this._hosts) {
      const row = document.createElement("div");
      row.className = "csRuntimeBlock csTwoRowCard csSshHostCard";
      const metadata = document.createElement("div");
      metadata.className = "csRuntimeDetails csCardMeta";
      metadata.appendChild(
        element(
          "span",
          [host.user, host.hostname, host.port].filter(Boolean).join(" · ") ||
            "Uses SSH defaults",
          "csMeta csCardMetaItem",
        ),
      );
      row.append(
        element("div", host.name, "csRuntimeName csCardTitle"),
        metadata,
      );
      card.appendChild(row);
    }
    if (!this._busy && this._hosts.length === 0) {
      card.appendChild(
        element("div", "No concrete SSH Host blocks found.", "csStatus"),
      );
    }
    root.appendChild(card);
    this.node.appendChild(root);
  }
}
