// SSH login key dialog: list, upload and remove the private keys a host can be
// assigned. Removal confirms inline, since JupyterLab would otherwise queue a
// second dialog behind the one open.
import { RemoteListWidget } from "./RebuildingWidget";
import { ISshKey } from "./Common";
import { ControlClient } from "./ControlClient";
import {
  addSection,
  button,
  confirmDelete,
  dialogBody,
  element,
  field,
  formFooter,
} from "./dom";

export class SshKeys extends RemoteListWidget {
  private _keys: ISshKey[] = [];
  private _form: { name: string; file: File | undefined } | undefined;

  constructor(private _api: ControlClient) {
    super();
    this.id = "cybershuttle-ssh-keys";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      this._keys = await this._api.listSshKeys();
    });
  }

  private async _upload(name: string, file: File): Promise<void> {
    await this._submitForm(async () => {
      await this._api.addSshKey(name.trim(), await readText(file));
      this._form = undefined;
    });
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "A stored key is kept for your account only. Pick it as a host's login key and that host signs in with it.",
      this._error,
    );
    scroll.appendChild(this._addSection());
    for (const key of this._keys) {
      card.appendChild(this._keyEntry(key));
    }
    if (!this._busy && this._keys.length === 0) {
      card.appendChild(element("div", "No login keys are stored.", "csStatus"));
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _addSection(): HTMLElement {
    return addSection(
      "Upload key",
      "upload-ssh-key-toggle",
      this._form && this._uploadForm(this._form),
      () => {
        this._form = this._form ? undefined : { name: "", file: undefined };
        this._formError = "";
        this._sync();
      },
    );
  }

  private _uploadForm(draft: {
    name: string;
    file: File | undefined;
  }): HTMLElement {
    const form = element("form", "", "csForm csSshAddForm");
    const name = element("input", "", "csInput");
    name.name = "sshKeyName";
    name.required = true;
    name.placeholder = "delta-key";
    name.value = draft.name;
    name.oninput = () => (draft.name = name.value);
    const file = element("input", "", "csInput");
    file.type = "file";
    file.name = "sshKeyFile";
    file.onchange = () => (draft.file = file.files?.[0]);
    const help = element(
      "div",
      "The private key file, such as ~/.ssh/id_ed25519. A passphrase is asked for at login.",
      "csFieldHelp",
    );
    const [error, footer] = formFooter(
      this._formError,
      this._saving ? "Uploading…" : "Upload",
      this._saving,
    );
    form.append(
      field("Name", name),
      field("Private key", file),
      help,
      error,
      footer,
    );
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!form.reportValidity() || this._saving) return;
      if (!draft.file) {
        this._formError = "Choose the private key file to upload.";
        this._sync();
        return;
      }
      void this._upload(draft.name, draft.file);
    };
    return form;
  }

  private _keyEntry(key: ISshKey): HTMLElement {
    const row = element("div", "", "csSshKeyRow");
    row.append(
      element("span", key.name, "csCardTitle"),
      element("span", `${key.type} ${key.fingerprint}`, "csMeta csSshKeyPrint"),
    );
    if (this._confirming === key.name) {
      row.append(
        ...confirmDelete(
          "Delete this key and unassign it?",
          `key-${key.name}`,
          () => this._confirm(""),
          () => void this._removeItem(() => this._api.removeSshKey(key.name)),
        ),
      );
      return row;
    }
    const remove = button("Delete", "csDangerButton", () =>
      this._confirm(key.name),
    );
    remove.dataset.sessionAction = `delete-key-${key.name}`;
    row.appendChild(remove);
    return row;
  }
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
