import { Widget } from "@lumino/widgets";
import { ISshHost } from "./Common";
import { ControlClient, errorMessage } from "./ControlClient";
import { button, element, field } from "./dom";

interface IHostTest {
  busy: boolean;
  ok?: boolean;
  message?: string;
}

export class SshHosts extends Widget {
  private _api: ControlClient;
  private _hosts: ISshHost[] = [];
  private _busy = false;
  private _error = "";
  private _adding = false;
  private _draft = { name: "", command: "" };
  private _addError = "";
  private _saving = false;
  // Expansion and test outcomes belong to the alias, so a re-render after any
  // action leaves the reader where they were.
  private _open = new Set<string>();
  private _tests = new Map<string, IHostTest>();
  // A dialog cannot ask this: JupyterLab queues a second dialog behind the one
  // already open, so the question would arrive after the answer was needed.
  private _confirming = "";

  constructor(api: ControlClient) {
    super();
    this._api = api;
    this.id = "cybershuttle-ssh-hosts";
    this.addClass("csRuntimePanel");
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

  private async _add(): Promise<void> {
    this._saving = true;
    this._addError = "";
    this._sync();
    try {
      await this._api.addSshHost(
        this._draft.name.trim(),
        this._draft.command.trim(),
      );
      if (this.isDisposed) {
        return;
      }
      this._adding = false;
      this._draft = { name: "", command: "" };
      this._saving = false;
      await this.refresh();
    } catch (error) {
      this._addError = errorMessage(error);
      this._saving = false;
      this._sync();
    }
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

  private _render(): void {
    this.node.textContent = "";
    const root = element("div", "", "csRoot csScrollRoot");
    // The dialog already names itself, so this opens with what the list means
    // and a rule under it. Both belong to the title: the list scrolls under
    // them, never with them.
    root.append(
      element(
        "div",
        "Hosts come from your SSH configuration. Add one here, or edit ~/.ssh/config directly.",
        "csModalSubtitle",
      ),
      element("hr", "", "csModalRule"),
    );
    const scroll = element("div", "", "csModalScroll");
    if (this._error) {
      scroll.appendChild(element("div", this._error, "csError"));
    }
    scroll.appendChild(this._addSection());
    const card = element("div", "", "csCard");
    for (const host of this._hosts) {
      card.appendChild(this._hostEntry(host));
    }
    if (!this._busy && this._hosts.length === 0) {
      card.appendChild(
        element("div", "No SSH hosts are configured.", "csStatus"),
      );
    }
    scroll.appendChild(card);
    root.appendChild(scroll);
    this.node.appendChild(root);
  }

  private _addSection(): HTMLElement {
    const section = element("div", "", "csSshAdd");
    const toggle = button(
      this._adding ? "Cancel" : "Add SSH Host",
      "csSecondaryButton csSshAddToggle",
      () => {
        this._adding = !this._adding;
        this._addError = "";
        this._render();
      },
    );
    section.appendChild(toggle);
    if (!this._adding) {
      return section;
    }
    const form = element("form", "", "csForm csSshAddForm");
    const name = element("input", "", "csInput");
    name.name = "sshHostName";
    name.required = true;
    name.placeholder = "delta";
    name.value = this._draft.name;
    name.oninput = () => (this._draft.name = name.value);
    const command = element("input", "", "csInput");
    command.name = "sshHostCommand";
    command.required = true;
    command.placeholder = "ssh -p 2222 me@login.example.edu";
    command.value = this._draft.command;
    command.oninput = () => (this._draft.command = command.value);
    const help = element(
      "div",
      "Paste the ssh command that already works. Host, user, port, identity, jump host, and -o options are kept.",
      "csFieldHelp",
    );
    const error = element("div", this._addError, "csError");
    error.hidden = !this._addError;
    const footer = element("div", "", "csFormFooter");
    const save = button(
      this._saving ? "Saving…" : "Save host",
      "csPrimaryButton",
    );
    save.type = "submit";
    save.disabled = this._saving;
    footer.appendChild(save);
    form.append(
      field("Name", name),
      field("SSH command", command),
      help,
      error,
      footer,
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      if (form.reportValidity() && !this._saving) {
        void this._add();
      }
    };
    section.appendChild(form);
    return section;
  }

  private _hostEntry(host: ISshHost): HTMLElement {
    const entry = document.createElement("details");
    entry.className = "csSshHostEntry";
    entry.open = this._open.has(host.name);
    entry.ontoggle = () =>
      entry.open ? this._open.add(host.name) : this._open.delete(host.name);
    const summary = document.createElement("summary");
    summary.className = "csSshHostSummary";
    summary.append(
      element("span", host.name, "csCardTitle"),
      element("span", hostTarget(host), "csMeta csSshHostTarget"),
    );
    const body = element("div", "", "csSshHostBody");
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
      const status = element(
        "div",
        test.busy ? "Connecting…" : (test.message ?? ""),
        `csSshHostStatus${test.busy ? "" : test.ok ? " csValidationPassed" : " csValidationFailed"}`,
      );
      status.setAttribute("role", "status");
      body.appendChild(status);
    }
    const actions = element("div", "", "csSshHostActions");
    if (this._confirming === host.name) {
      actions.append(
        element("span", "Remove this entry from ~/.ssh/config?", "csMeta"),
        button("Cancel", "csSecondaryButton", () => {
          this._confirming = "";
          this._render();
        }),
        button("Delete", "csDangerButton", () => void this._remove(host)),
      );
      body.appendChild(actions);
      entry.append(summary, body);
      return entry;
    }
    const testButton = button(
      "Test connection",
      "csSecondaryButton",
      () => void this._test(host),
    );
    testButton.disabled = test?.busy ?? false;
    const remove = button("Delete", "csDangerButton", () => {
      this._confirming = host.name;
      this._render();
    });
    // Only entries CyberShuttle wrote are ours to remove.
    remove.disabled = !host.managed;
    if (!host.managed) {
      remove.title = "This host comes from your own SSH configuration.";
    }
    actions.append(testButton, remove);
    body.appendChild(actions);
    entry.append(summary, body);
    return entry;
  }
}

function hostTarget(host: ISshHost): string {
  const target = [host.user && `${host.user}@`, host.hostname]
    .filter(Boolean)
    .join("");
  // The port is a detail of the connection, not a name for it.
  return target || "Uses SSH defaults";
}

// The rows read as the configuration does, so what the UI shows and what ssh
// uses are the same list.
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
