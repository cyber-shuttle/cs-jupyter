// SSH host management dialog: list, add, edit, test and remove entries from
// ~/.ssh/config. Only entries CyberShuttle itself wrote can be edited or
// removed. Removal confirms inline, since JupyterLab would otherwise queue a
// second dialog behind the one already open.
import { RemoteListWidget } from "./RebuildingWidget";
import { errorMessage, ISshHost, ISshKey } from "./Common";
import { ControlClient } from "./ControlClient";
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

interface IHostDraft {
  alias: string;
  name: string;
  command: string;
  key: string;
}

interface IHostTest {
  busy: boolean;
  ok?: boolean;
  message?: string;
}

export class SshHosts extends RemoteListWidget {
  private _api: ControlClient;
  private _hosts: ISshHost[] = [];
  private _keys: ISshKey[] = [];
  private _form: IHostDraft | undefined;
  private _addError = "";
  private _saving = false;
  private _open = new Set<string>();
  private _tests = new Map<string, IHostTest>();

  constructor(api: ControlClient) {
    super();
    this._api = api;
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

  private async _save(form: IHostDraft): Promise<void> {
    this._saving = true;
    this._addError = "";
    this._sync();
    try {
      await (form.alias
        ? this._api.updateSshHost(form.alias, form.command.trim(), form.key)
        : this._api.addSshHost(
            form.name.trim(),
            form.command.trim(),
            form.key,
          ));
      if (this.isDisposed) {
        return;
      }
      this._form = undefined;
      this._saving = false;
      await this.refresh();
    } catch (error) {
      this._addError = errorMessage(error);
      this._saving = false;
      this._sync();
    }
  }

  private _openForm(form: IHostDraft | undefined): void {
    this._form = form;
    this._addError = "";
    this._render();
  }

  private async _remove(host: ISshHost): Promise<void> {
    await this._removeItem(() => this._api.removeSshHost(host.name));
  }

  private async _test(host: ISshHost): Promise<void> {
    this._tests.set(host.name, { busy: true });
    this._sync();
    try {
      const result = await this._api.testSshHost(host.name);
      this._tests.set(host.name, { busy: false, ...result });
    } catch (error) {
      this._tests.set(host.name, {
        busy: false,
        ok: false,
        message: errorMessage(error),
      });
    }
    this._sync();
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Hosts come from your SSH configuration. Add one here, or edit ~/.ssh/config directly.",
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
    const adding = this._form?.alias === "";
    return addSection(
      "Add SSH Host",
      "add-ssh-host-toggle",
      adding && this._form ? this._pasteForm(this._form) : undefined,
      () =>
        this._openForm(
          adding ? undefined : { alias: "", name: "", command: "", key: "" },
        ),
    );
  }

  private _pasteForm(draft: IHostDraft): HTMLElement {
    const form = element("form", "", "csForm csSshAddForm");
    const command = element("input", "", "csInput");
    command.name = "sshHostCommand";
    command.dataset.sessionAction = "ssh-host-command";
    command.required = true;
    command.placeholder = "ssh -p 2222 me@login.example.edu";
    command.value = draft.command;
    command.oninput = () => (draft.command = command.value);
    const help = element(
      "div",
      "Paste the ssh command that already works. Host, user, port, identity, jump host, and -o options are kept.",
      "csFieldHelp",
    );
    const key = select(
      "sshHostKey",
      [
        ["", "None"],
        ...this._keys.map((stored): [string, string] => [
          stored.name,
          stored.name,
        ]),
      ],
      false,
    );
    key.dataset.sessionAction = "ssh-host-key";
    key.value = draft.key;
    key.onchange = () => (draft.key = key.value);
    const keyHelp = element(
      "div",
      "A stored login key signs in to this host in place of any -i identity.",
      "csFieldHelp",
    );
    const [error, footer] = formFooter(
      this._addError,
      this._saving ? "Saving…" : draft.alias ? "Save changes" : "Save host",
      this._saving,
    );
    if (!draft.alias) {
      const name = element("input", "", "csInput");
      name.name = "sshHostName";
      name.dataset.sessionAction = "ssh-host-name";
      name.required = true;
      name.placeholder = "delta";
      name.value = draft.name;
      name.oninput = () => (draft.name = name.value);
      form.appendChild(field("Name", name));
    }
    form.append(
      field("SSH command", command),
      help,
      field("Login key", key),
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
    const remove = button("Delete", "csDangerButton");
    remove.dataset.sessionAction = `delete-${host.name}`;
    remove.disabled = !host.managed;
    remove.onclick = (event) => {
      event.preventDefault();
      this._confirming = host.name;
      this._render();
    };
    const { entry, body } = disclosure(host.name, this._open, [
      element("span", host.name, "csCardTitle"),
      element("span", hostTarget(host), "csMeta csSshHostTarget"),
      ...(this._confirming === host.name ? [] : [remove]),
    ]);
    for (const [key, value] of hostArguments(host)) {
      const row = element("div", "", "csSshArgRow");
      row.append(
        element("span", key, "csSshArgKey"),
        element("span", value, "csSshArgValue"),
      );
      body.appendChild(row);
    }
    const test = this._tests.get(host.name);
    if (test) {
      body.appendChild(
        element(
          "div",
          test.busy ? "Connecting…" : (test.message ?? ""),
          `csSshHostStatus${test.busy ? "" : test.ok ? " csValidationPassed" : " csValidationFailed"}`,
          { role: "status" },
        ),
      );
    }
    const actions = element("div", "", "csSshHostActions");
    if (this._confirming === host.name) {
      actions.append(
        ...confirmDelete(
          "Remove this entry from ~/.ssh/config?",
          host.name,
          () => {
            this._confirming = "";
            this._render();
          },
          () => void this._remove(host),
        ),
      );
      body.appendChild(actions);
      return entry;
    }
    const editing = this._form?.alias === host.name;
    const testButton = button(
      "Test connection",
      "csSecondaryButton",
      () => void this._test(host),
    );
    testButton.dataset.sessionAction = `test-${host.name}`;
    testButton.disabled = test?.busy ?? false;
    const edit = button(editing ? "Cancel" : "Edit", "csSecondaryButton", () =>
      this._openForm(
        editing
          ? undefined
          : {
              alias: host.name,
              name: host.name,
              command: hostCommand(host),
              key: host.key ?? "",
            },
      ),
    );
    edit.dataset.sessionAction = `edit-${host.name}`;
    edit.disabled = !host.managed;
    if (!host.managed) {
      const own = "This host comes from your own SSH configuration.";
      edit.title = own;
      remove.title = own;
    }
    actions.append(edit, testButton);
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
  if (host.key) rows.push(["Login key", host.key]);
  else if (host.identityFile) rows.push(["IdentityFile", host.identityFile]);
  for (const directive of host.extraDirectives) {
    const [key, ...rest] = directive.trim().split(/\s+/);
    if (host.key && key === "IdentitiesOnly") continue;
    rows.push([key, rest.join(" ")]);
  }
  return rows;
}

function hostCommand(host: ISshHost): string {
  const parts = ["ssh"];
  if (host.port && host.port !== 22) parts.push("-p", String(host.port));
  if (host.identityFile && !host.key) parts.push("-i", host.identityFile);
  for (const [key, value] of hostArguments(host)) {
    if (["HostName", "User", "Port", "IdentityFile", "Login key"].includes(key))
      continue;
    parts.push(
      ...(key === "ProxyJump" ? ["-J", value] : ["-o", `${key}=${value}`]),
    );
  }
  const target = host.hostname || host.name;
  parts.push(host.user ? `${host.user}@${target}` : target);
  return parts.join(" ");
}
