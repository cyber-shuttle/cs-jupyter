// SSH host management dialog: list, add, edit, test and remove entries from
// ~/.ssh/config. Only entries CyberShuttle itself wrote can be edited or
// removed. Removal confirms inline, since JupyterLab would otherwise queue a
// second dialog behind the one already open.
import { RebuildingWidget } from "./RebuildingWidget";
import { errorMessage, ISshHost } from "./Common";
import { ControlClient } from "./ControlClient";
import { button, disclosure, element, field, modalBody } from "./dom";

interface IHostTest {
  busy: boolean;
  ok?: boolean;
  message?: string;
}

export class SshHosts extends RebuildingWidget {
  private _api: ControlClient;
  private _hosts: ISshHost[] = [];
  private _busy = false;
  private _error = "";
  private _form: { alias: string; name: string; command: string } | undefined;
  private _addError = "";
  private _saving = false;
  private _open = new Set<string>();
  private _tests = new Map<string, IHostTest>();
  private _confirming = "";

  constructor(api: ControlClient) {
    super();
    this._api = api;
    this.id = "cybershuttle-ssh-hosts";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    this._busy = true;
    this._error = "";
    this._sync();
    try {
      this._hosts = await this._api.listSshHosts();
    } catch (error) {
      this._error = errorMessage(error);
    } finally {
      this._busy = false;
      this._sync();
    }
  }

  private async _save(form: {
    alias: string;
    name: string;
    command: string;
  }): Promise<void> {
    this._saving = true;
    this._addError = "";
    this._sync();
    try {
      await (form.alias
        ? this._api.updateSshHost(form.alias, form.command.trim())
        : this._api.addSshHost(form.name.trim(), form.command.trim()));
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

  private _openForm(form: typeof this._form): void {
    this._form = form;
    this._addError = "";
    this._render();
  }

  private async _remove(host: ISshHost): Promise<void> {
    this._confirming = "";
    try {
      await this._api.removeSshHost(host.name);
      await this.refresh();
    } catch (error) {
      this._error = errorMessage(error);
      this._sync();
    }
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

  private _sync(): void {
    if (!this.isDisposed) {
      this._render();
    }
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = modalBody(
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
    const section = element("div", "", "csSshAdd");
    const toggle = button(
      adding ? "Cancel" : "Add SSH Host",
      "csSecondaryButton csSshAddToggle",
      () =>
        this._openForm(
          adding ? undefined : { alias: "", name: "", command: "" },
        ),
    );
    toggle.dataset.sessionAction = "add-ssh-host-toggle";
    section.appendChild(toggle);
    if (this._form && adding) {
      section.appendChild(this._pasteForm(this._form));
    }
    return section;
  }

  private _pasteForm(draft: {
    alias: string;
    name: string;
    command: string;
  }): HTMLElement {
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
    const error = element("div", this._addError, "csError");
    error.hidden = !this._addError;
    const footer = element("div", "", "csFormFooter");
    const save = button(
      this._saving ? "Saving…" : draft.alias ? "Save changes" : "Save host",
      "csPrimaryButton",
    );
    save.type = "submit";
    save.disabled = this._saving;
    footer.appendChild(save);
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
    form.append(field("SSH command", command), help, error, footer);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (form.reportValidity() && !this._saving) {
        void this._save(draft);
      }
    };
    return form;
  }

  private _hostEntry(host: ISshHost): HTMLElement {
    const { entry, body } = disclosure(host.name, this._open, [
      element("span", host.name, "csCardTitle"),
      element("span", hostTarget(host), "csMeta csSshHostTarget"),
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
      const cancelConfirm = button("Cancel", "csSecondaryButton", () => {
        this._confirming = "";
        this._render();
      });
      cancelConfirm.dataset.sessionAction = `confirm-cancel-${host.name}`;
      const deleteConfirm = button(
        "Delete",
        "csDangerButton",
        () => void this._remove(host),
      );
      deleteConfirm.dataset.sessionAction = `confirm-delete-${host.name}`;
      actions.append(
        element("span", "Remove this entry from ~/.ssh/config?", "csMeta"),
        cancelConfirm,
        deleteConfirm,
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
          : { alias: host.name, name: host.name, command: hostCommand(host) },
      ),
    );
    edit.dataset.sessionAction = `edit-${host.name}`;
    const remove = button("Delete", "csDangerButton", () => {
      this._confirming = host.name;
      this._render();
    });
    remove.dataset.sessionAction = `delete-${host.name}`;
    edit.disabled = !host.managed;
    remove.disabled = !host.managed;
    if (!host.managed) {
      const own = "This host comes from your own SSH configuration.";
      edit.title = own;
      remove.title = own;
    }
    actions.append(testButton, edit, remove);
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
  if (host.identityFile) rows.push(["IdentityFile", host.identityFile]);
  for (const directive of host.extraDirectives) {
    const [key, ...rest] = directive.trim().split(/\s+/);
    rows.push([key, rest.join(" ")]);
  }
  return rows;
}

function hostCommand(host: ISshHost): string {
  const parts = ["ssh"];
  if (host.port && host.port !== 22) parts.push("-p", String(host.port));
  if (host.identityFile) parts.push("-i", host.identityFile);
  for (const [key, value] of hostArguments(host)) {
    if (["HostName", "User", "Port", "IdentityFile"].includes(key)) continue;
    parts.push(
      ...(key === "ProxyJump" ? ["-J", value] : ["-o", `${key}=${value}`]),
    );
  }
  const target = host.hostname || host.name;
  parts.push(host.user ? `${host.user}@${target}` : target);
  return parts.join(" ");
}
