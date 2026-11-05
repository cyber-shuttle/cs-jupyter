// Credential dialog: list, add and delete the caller's SSH keypairs and
// passwords. The private key goes from its file straight into the create
// request, never into state. Deletion confirms inline.
import { RemoteListWidget } from "./RebuildingWidget";
import type { Schemas } from "./Common";
import { PlaneClient } from "./PlaneClient";
import {
  addSection,
  button,
  confirmDelete,
  dialogBody,
  element,
  field,
  formFooter,
  select,
} from "./dom";

type ICredentialDraft = Schemas["SSHCredentialRequest"] & { file?: File };

export class SshKeys extends RemoteListWidget {
  private _keys: Schemas["SSHCredentialResponse"][] = [];
  private _form: ICredentialDraft | undefined;

  constructor(private _api: PlaneClient) {
    super();
    this.id = "cybershuttle-ssh-keys";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      this._keys = (await this._api.listCredentials()).filter(
        (each) => !each.fullInteractive,
      );
    });
  }

  private async _save({ file, ...request }: ICredentialDraft): Promise<void> {
    await this._submitForm(async () => {
      await this._api.addCredential({
        ...request,
        sshCredentialName: request.sshCredentialName.trim(),
        privateKey: file && (await readText(file)),
      });
      this._form = undefined;
    });
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "A credential is kept for your account only. Assign it to a compute host and logins there use it.",
      this._error,
    );
    scroll.appendChild(this._addSection());
    for (const key of this._keys) {
      card.appendChild(this._keyEntry(key));
    }
    if (!this._busy && this._keys.length === 0) {
      card.appendChild(
        element("div", "No credentials are stored.", "csStatus"),
      );
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _addSection(): HTMLElement {
    return addSection(
      "Add credential",
      "add-credential-toggle",
      this._form && this._addForm(this._form),
      () => {
        this._form = this._form ? undefined : { sshCredentialName: "" };
        this._formError = "";
        this._sync();
      },
    );
  }

  private _addForm(draft: ICredentialDraft): HTMLElement {
    const form = element("form", "", "csForm csSshAddForm");
    const kind = select("credentialKind", [
      ["keypair", "Keypair"],
      ["password", "Password"],
    ]);
    kind.dataset.sessionAction = "credential-kind";
    kind.value = draft.password != null ? "password" : "keypair";
    kind.onchange = () => {
      this._form = {
        sshCredentialName: draft.sshCredentialName,
        ...(kind.value === "password" && { password: "" }),
      };
      this._sync();
    };
    const name = element("input", "", "csInput");
    name.name = "credentialName";
    name.dataset.sessionAction = "credential-name";
    name.required = true;
    name.placeholder = "cluster-key";
    name.value = draft.sshCredentialName;
    name.oninput = () => (draft.sshCredentialName = name.value);
    form.append(field("Kind", kind), field("Name", name));
    if (kind.value === "password") {
      const password = element("input", "", "csInput");
      password.type = "password";
      password.name = "credentialPassword";
      password.dataset.sessionAction = "credential-password";
      password.required = true;
      password.autocomplete = "off";
      password.value = draft.password ?? "";
      password.oninput = () => (draft.password = password.value);
      form.append(
        field("Password", password),
        element(
          "div",
          "Logins send this password. Anything else the host asks, such as a one-time code, you answer yourself.",
          "csFieldHelp",
        ),
      );
    } else {
      const publicKey = element("textarea", "", "csInput");
      publicKey.name = "credentialPublicKey";
      publicKey.dataset.sessionAction = "credential-public-key";
      publicKey.required = true;
      publicKey.rows = 3;
      publicKey.placeholder = "ssh-ed25519 AAAA… me@laptop";
      publicKey.value = draft.publicKey ?? "";
      publicKey.oninput = () => (draft.publicKey = publicKey.value.trim());
      form.appendChild(field("Public key", publicKey));
      const file = element("input", "", "csInput");
      file.type = "file";
      file.name = "credentialPrivateKey";
      file.onchange = () => (draft.file = file.files?.[0]);
      const passphrase = element("input", "", "csInput");
      passphrase.type = "password";
      passphrase.name = "credentialPassphrase";
      passphrase.autocomplete = "off";
      passphrase.value = draft.passphrase ?? "";
      passphrase.oninput = () =>
        (draft.passphrase = passphrase.value || undefined);
      form.append(
        field("Private key", file),
        element(
          "div",
          "The private key file, such as ~/.ssh/id_ed25519.",
          "csFieldHelp",
        ),
        field("Passphrase (optional)", passphrase),
      );
    }
    const [error, footer] = formFooter(
      this._formError,
      this._saving ? "Saving…" : "Save credential",
      this._saving,
    );
    form.append(error, footer);
    form.onsubmit = (event) => {
      event.preventDefault();
      if (!form.reportValidity() || this._saving) return;
      if (kind.value === "keypair" && !draft.file) {
        this._formError = "Choose the private key file to upload.";
        this._sync();
        return;
      }
      void this._save(draft);
    };
    return form;
  }

  private _keyEntry(credential: Schemas["SSHCredentialResponse"]): HTMLElement {
    const id = credential.sshCredentialId;
    const row = element("div", "", "csSshKeyRow");
    row.append(
      element("span", credential.sshCredentialName, "csCardTitle"),
      element(
        "span",
        credential.publicKey || "Password",
        "csMeta csSshKeyPrint",
      ),
    );
    if (this._confirming === id) {
      row.append(
        ...confirmDelete(
          "Delete this credential?",
          `credential-${id}`,
          () => this._confirm(""),
          () => void this._deleteItem(() => this._api.deleteCredential(id)),
        ),
      );
      return row;
    }
    const del = button("Delete", "csDangerButton", () => this._confirm(id));
    del.dataset.sessionAction = `delete-credential-${id}`;
    row.appendChild(del);
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
