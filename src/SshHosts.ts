// SSH host management dialog: list, add, edit, check and delete entries in
// ~/.ssh/config. Only entries cs-plane itself wrote can be edited or deleted.
// Deletion confirms inline, since JupyterLab would otherwise queue a second
// dialog behind the one already open.
import { RemoteListWidget } from "./RebuildingWidget";
import { errorMessage, ISshHostHealth, ISshHost, ISshKey } from "./Common";
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

interface ISshHostDraft {
  editing: string;
  alias: string;
  command: string;
  keyId: string;
}

type ISshHostHealthCheck = Partial<ISshHostHealth> & { busy: boolean };

export class SshHosts extends RemoteListWidget {
  private _hosts: ISshHost[] = [];
  private _keys: ISshKey[] = [];
  private _form: ISshHostDraft | undefined;
  private _open = new Set<string>();
  private _health = new Map<string, ISshHostHealthCheck>();

  constructor(private _api: PlaneClient) {
    super();
    this.id = "cybershuttle-ssh-hosts";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      [this._hosts, this._keys] = await Promise.all([
        this._api.listSshHosts(),
        this._api.listSshKeys(),
      ]);
    });
  }

  private async _save(form: ISshHostDraft): Promise<void> {
    await this._submitForm(async () => {
      await (form.editing
        ? this._api.updateSshHost(form.editing, form.command.trim(), form.keyId)
        : this._api.addSshHost(
            form.alias.trim(),
            form.command.trim(),
            form.keyId,
          ));
      this._form = undefined;
    });
  }

  private _openForm(form: ISshHostDraft | undefined): void {
    this._form = form;
    this._formError = "";
    this._sync();
  }

  private async _checkHealth(host: ISshHost): Promise<void> {
    this._health.set(host.alias, { busy: true });
    this._sync();
    const result = await this._api
      .sshHostHealth(host.alias)
      .catch((error) => ({ ok: false, message: errorMessage(error) }));
    this._health.set(host.alias, { busy: false, ...result });
    this._sync();
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "SSH hosts come from your SSH configuration. Add one here, or edit ~/.ssh/config directly.",
      this._error,
    );
    scroll.appendChild(this._addSection());
    for (const host of this._hosts) {
      card.appendChild(this._hostEntry(host));
    }
    if (!this._busy && this._hosts.length === 0) {
      card.appendChild(
        element("div", "No SSH hosts are configured.", "csStatus"),
      );
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _addSection(): HTMLElement {
    const adding = this._form?.editing === "";
    return addSection(
      "Add SSH Host",
      "add-ssh-host-toggle",
      adding && this._form ? this._pasteForm(this._form) : undefined,
      () =>
        this._openForm(
          adding
            ? undefined
            : { editing: "", alias: "", command: "", keyId: "" },
        ),
    );
  }

  private _pasteForm(draft: ISshHostDraft): HTMLElement {
    const form = element("form", "", "csForm csSshAddForm");
    const command = element("input", "", "csInput");
    command.name = "sshHostCommand";
    command.dataset.sessionAction = "ssh-host-command";
    command.required = true;
    command.placeholder = "ssh -p 2222 me@delta.example.edu";
    command.value = draft.command;
    command.oninput = () => (draft.command = command.value);
    const help = element(
      "div",
      "Paste the ssh command that already works. Hostname, user, port, identity, jump host, and -o options are kept.",
      "csFieldHelp",
    );
    const key = select(
      "sshHostKey",
      [
        ["", "None"],
        ...this._keys.map((stored): [string, string] => [stored.id, stored.id]),
      ],
      false,
    );
    key.dataset.sessionAction = "ssh-host-key";
    key.value = draft.keyId;
    key.onchange = () => (draft.keyId = key.value);
    const keyHelp = element(
      "div",
      "SSH authentication to this SSH host uses the stored SSH key in place of any -i identity.",
      "csFieldHelp",
    );
    const [error, footer] = formFooter(
      this._formError,
      this._saving
        ? "Saving…"
        : draft.editing
          ? "Save changes"
          : "Save SSH host",
      this._saving,
    );
    if (!draft.editing) {
      const alias = element("input", "", "csInput");
      alias.name = "alias";
      alias.dataset.sessionAction = "ssh-host-alias";
      alias.required = true;
      alias.placeholder = "delta";
      alias.value = draft.alias;
      alias.oninput = () => (draft.alias = alias.value);
      form.appendChild(field("Alias", alias));
    }
    form.append(
      field("SSH command", command),
      help,
      field("SSH key", key),
      keyHelp,
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

  private _hostEntry(host: ISshHost): HTMLElement {
    const del = button("Delete", "csDangerButton");
    del.dataset.sessionAction = `delete-${host.alias}`;
    del.disabled = !host.managed;
    del.onclick = (event) => {
      event.preventDefault();
      this._confirm(host.alias);
    };
    const { entry, body } = disclosure(host.alias, this._open, [
      element("span", host.alias, "csCardTitle"),
      element("span", hostTarget(host), "csMeta csSshHostTarget"),
      ...(this._confirming === host.alias ? [] : [del]),
    ]);
    for (const [key, value] of hostArguments(host)) {
      const row = element("div", "", "csSshArgRow");
      row.append(
        element("span", key, "csSshArgKey"),
        element("span", value, "csSshArgValue"),
      );
      body.appendChild(row);
    }
    const health = this._health.get(host.alias);
    if (health) {
      body.appendChild(
        element(
          "div",
          health.busy ? "Connecting…" : (health.message ?? ""),
          `csSshHostStatus${health.busy ? "" : health.ok ? " csValidationPassed" : " csValidationFailed"}`,
          { role: "status" },
        ),
      );
    }
    const actions = element("div", "", "csSshHostActions");
    if (this._confirming === host.alias) {
      actions.append(
        ...confirmDelete(
          "Delete this entry from ~/.ssh/config?",
          host.alias,
          () => this._confirm(""),
          () =>
            void this._deleteItem(() => this._api.deleteSshHost(host.alias)),
        ),
      );
      body.appendChild(actions);
      return entry;
    }
    const editing = this._form?.editing === host.alias;
    const healthButton = button(
      "Check health",
      "csSecondaryButton",
      () => void this._checkHealth(host),
    );
    healthButton.dataset.sessionAction = `health-${host.alias}`;
    healthButton.disabled = health?.busy ?? false;
    const edit = button(editing ? "Cancel" : "Edit", "csSecondaryButton", () =>
      this._openForm(
        editing
          ? undefined
          : {
              editing: host.alias,
              alias: host.alias,
              command: hostCommand(host),
              keyId: host.keyId ?? "",
            },
      ),
    );
    edit.dataset.sessionAction = `edit-${host.alias}`;
    edit.disabled = !host.managed;
    if (!host.managed) {
      const own = "This SSH host comes from your own SSH configuration.";
      edit.title = own;
      del.title = own;
    }
    actions.append(edit, healthButton);
    body.appendChild(actions);
    if (this._form && editing) {
      body.appendChild(this._pasteForm(this._form));
    }
    return entry;
  }
}

function hostTarget(host: ISshHost): string {
  const target = [host.user && `${host.user}@`, host.hostname]
    .filter(Boolean)
    .join("");
  return target || "Uses SSH defaults";
}

function hostArguments(host: ISshHost): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (host.hostname) rows.push(["HostName", host.hostname]);
  if (host.user) rows.push(["User", host.user]);
  if (host.port && host.port !== 22) {
    rows.push(["Port", String(host.port)]);
  }
  if (host.keyId) rows.push(["SSH key", host.keyId]);
  for (const directive of host.extraDirectives) {
    const [key, ...rest] = directive.trim().split(/\s+/);
    rows.push([key, rest.join(" ")]);
  }
  return rows;
}

function hostCommand(host: ISshHost): string {
  const parts = ["ssh"];
  if (host.port && host.port !== 22) parts.push("-p", String(host.port));
  for (const [key, value] of hostArguments(host)) {
    if (["HostName", "User", "Port", "SSH key"].includes(key)) continue;
    parts.push(
      ...(key === "ProxyJump" ? ["-J", value] : ["-o", `${key}=${value}`]),
    );
  }
  const target = host.hostname || host.alias;
  parts.push(host.user ? `${host.user}@${target}` : target);
  return parts.join(" ");
}
