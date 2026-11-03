import type { Schemas } from "./Common";
import { button, element, field, formFooter } from "./dom";
import type { PlaneClient } from "./PlaneClient";

export class LoginPrompts {
  private _asking = false;

  constructor(
    private _api: Pick<PlaneClient, "listLoginPrompts" | "answerLoginPrompt">,
  ) {}

  async check(): Promise<void> {
    if (this._asking) return;
    this._asking = true;
    try {
      const [prompt] = await this._api.listLoginPrompts();
      if (prompt) await this._ask(prompt);
    } catch {
      // The login is still pending; the next poll asks again.
    } finally {
      this._asking = false;
    }
  }

  // Its own overlay: JupyterLab queues a second Dialog behind an open one.
  private async _ask(auth: Schemas["InteractiveAuthResponse"]): Promise<void> {
    const form = element("form", "", "jp-Dialog-content csForm");
    form.append(
      element(
        "div",
        `Log in to ${auth.loginUser}@${auth.hostName}`,
        "jp-Dialog-header",
      ),
    );
    for (const text of [auth.banner, auth.instruction]) {
      if (text) form.append(element("pre", text, "csLoginBanner"));
    }
    const inputs = auth.prompts.map((prompt) => {
      const input = element("input", "", "csInput");
      input.type = prompt.echo ? "text" : "password";
      input.autocomplete = "off";
      form.append(field(prompt.text, input));
      return input;
    });
    const cancel = button("Cancel", "csSecondaryButton");
    const [, footer] = formFooter("", "Log in", false);
    footer.prepend(cancel);
    form.append(footer);
    const overlay = element("div", "", "jp-Dialog csLoginOverlay");
    overlay.append(form);
    document.body.append(overlay);
    inputs[0]?.focus();
    const accepted = await new Promise<boolean>((resolve) => {
      cancel.onclick = () => resolve(false);
      form.onsubmit = (event) => {
        event.preventDefault();
        resolve(true);
      };
    });
    overlay.remove();
    await this._api.answerLoginPrompt(
      auth.authId,
      accepted
        ? { responses: inputs.map((input) => input.value) }
        : { cancel: true },
    );
  }
}
