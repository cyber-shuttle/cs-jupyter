// Compute host dialog: list, add and delete the caller's cluster configs. Only
// owned ones delete. Deletion confirms inline, since JupyterLab would otherwise
// queue a second dialog behind the one already open.
import { RemoteListWidget } from "./RebuildingWidget";
import { configLogin, configName, type Schemas } from "./Common";
import { PlaneClient } from "./PlaneClient";
import {
  addSection,
  button,
  confirmDelete,
  dialogBody,
  disclosure,
  element,
  field,
  formFooter,
  select,
} from "./dom";

export class SshHosts extends RemoteListWidget {
  private _hosts: Schemas["SlurmClusterConfigResponse"][] = [];
  private _clusters: Schemas["SlurmClusterResponse"][] = [];
  private _credentials: Schemas["SSHCredentialResponse"][] = [];
  private _form: Schemas["SlurmClusterConfigRequest"] | undefined;
  private _open = new Set<string>();

  constructor(private _api: PlaneClient) {
    super();
    this.id = "cybershuttle-ssh-hosts";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      [this._hosts, this._clusters, this._credentials] = await Promise.all([
        this._api.listConfigs(),
        this._api.listSlurmClusters(),
        this._api.listCredentials(),
      ]);
    });
  }

  private async _save(
    form: Schemas["SlurmClusterConfigRequest"],
  ): Promise<void> {
    await this._submitForm(async () => {
      await this._api.addComputeHost({
        ...form,
        loginUser: form.loginUser.trim(),
        workRoot: form.workRoot.trim(),
      });
      this._form = undefined;
    });
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Sessions run on a compute host: your login on a cluster.",
      this._error,
    );
    scroll.appendChild(this._addSection());
    for (const host of this._hosts) {
      card.appendChild(this._hostEntry(host));
    }
    if (!this._busy && this._hosts.length === 0) {
      card.appendChild(
        element("div", "No compute hosts are configured.", "csStatus"),
      );
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _addSection(): HTMLElement {
    return addSection(
      "Add Compute Host",
      "add-compute-host-toggle",
      this._form && this._addForm(this._form),
      () => {
        this._form = this._form
          ? undefined
          : {
              slurmClusterId: this._clusters[0]?.slurmClusterId ?? "",
              loginUser: "",
              workRoot: "",
              sshCredentialId: this._credentials[0]?.sshCredentialId ?? "",
            };
        this._formError = "";
        this._sync();
      },
    );
  }

  private _addForm(draft: Schemas["SlurmClusterConfigRequest"]): HTMLElement {
    const form = element("form", "", "csForm csSshAddForm");
    const cluster = select(
      "computeHostCluster",
      this._clusters.map((each) => [
        each.slurmClusterId,
        `${each.clusterName} (${each.headnodeHost}:${each.headnodePort})`,
      ]),
    );
    cluster.dataset.sessionAction = "compute-host-cluster";
    cluster.value = draft.slurmClusterId;
    cluster.onchange = () => (draft.slurmClusterId = cluster.value);
    const loginUser = element("input", "", "csInput");
    loginUser.name = "computeHostLoginUser";
    loginUser.dataset.sessionAction = "compute-host-login-user";
    loginUser.required = true;
    loginUser.placeholder = "me";
    loginUser.value = draft.loginUser;
    loginUser.oninput = () => (draft.loginUser = loginUser.value);
    const workRoot = element("input", "", "csInput");
    workRoot.name = "computeHostWorkRoot";
    workRoot.dataset.sessionAction = "compute-host-work-root";
    workRoot.required = true;
    workRoot.placeholder = "/home/me/cybershuttle";
    workRoot.value = draft.workRoot;
    workRoot.oninput = () => (draft.workRoot = workRoot.value);
    const credential = select(
      "computeHostCredential",
      this._credentials.map((each) => [
        each.sshCredentialId,
        each.sshCredentialName,
      ]),
    );
    credential.dataset.sessionAction = "compute-host-credential";
    credential.value = draft.sshCredentialId;
    credential.onchange = () => (draft.sshCredentialId = credential.value);
    const help = element(
      "div",
      "Logins to this compute host use the credential; add one under Credentials.",
      "csFieldHelp",
    );
    const [error, footer] = formFooter(
      this._formError,
      this._saving ? "Saving…" : "Save compute host",
      this._saving,
    );
    form.append(
      field("Cluster", cluster),
      field("Login user", loginUser),
      field("Work root", workRoot),
      field("Credential", credential),
      help,
      error,
      footer,
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      if (form.reportValidity() && !this._saving) {
        void this._save(draft);
      }
    };
    return form;
  }

  private _hostEntry(host: Schemas["SlurmClusterConfigResponse"]): HTMLElement {
    const id = host.slurmClusterConfigId;
    const owned = !host.permission;
    const del = button("Delete", "csDangerButton");
    del.dataset.sessionAction = `delete-${id}`;
    del.disabled = !owned;
    if (!owned) del.title = "This compute host is shared with you.";
    del.onclick = (event) => {
      event.preventDefault();
      this._open.add(id);
      this._confirm(id);
    };
    const { entry, body } = disclosure(id, this._open, [
      element("span", configName(host), "csCardTitle"),
      element(
        "span",
        `${configLogin(host)} · ${owned ? "Owned" : "Shared"}`,
        "csMeta csSshHostTarget",
      ),
      ...(this._confirming === id ? [] : [del]),
    ]);
    for (const [key, value] of [
      ["Login user", host.loginUser],
      ["Work root", host.workRoot],
      ["Credential", host.sshCredential?.sshCredentialName ?? ""],
    ]) {
      const row = element("div", "", "csSshArgRow");
      row.append(
        element("span", key, "csSshArgKey"),
        element("span", value, "csSshArgValue"),
      );
      body.appendChild(row);
    }
    if (this._confirming === id) {
      const actions = element("div", "", "csSshHostActions");
      actions.append(
        ...confirmDelete(
          "Delete this compute host?",
          id,
          () => this._confirm(""),
          () => void this._deleteItem(() => this._api.deleteComputeHost(id)),
        ),
      );
      body.appendChild(actions);
    }
    return entry;
  }
}
