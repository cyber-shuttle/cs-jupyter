import { Widget } from "@lumino/widgets";
import type { OAuthWebSocketConnector } from "./OAuthWebSocket";
import { element } from "./dom";
import {
  createSshOperationConsole,
  ISshOperationConsole,
  SshOperationConsoleFactory,
} from "./SshOperationConsole";

interface IPendingLogin {
  resolve: () => void;
  reject: (reason: Error) => void;
}

// The console has to outlive the view it is answering for: RuntimeDetail
// rebuilds its whole subtree several times a second on the poll, which would
// take the terminal's focus away from whoever is typing a password. The dock is
// its sibling in the dialog body instead, so nothing rebuilds it.
export class SshLoginDock extends Widget {
  private _console: ISshOperationConsole | undefined;
  private _pending: IPendingLogin | undefined;
  private _status = element("div", "", "csSshAuthStatus");
  private _title = element("strong", "Interactive SSH login");
  private _host = element("div", "", "csSshAuthHost");

  constructor(
    private _consoleFactory: SshOperationConsoleFactory = createSshOperationConsole,
  ) {
    super();
    this.addClass("csSshAuth");
    this.addClass("csLoginDock");
    this._status.setAttribute("role", "status");
    const header = element("div", "", "csSshAuthHeader");
    const cancel = element("button", "Cancel", "csTextButton");
    (cancel as HTMLButtonElement).type = "button";
    cancel.onclick = () => this.cancel();
    header.append(this._title, cancel);
    this.node.append(header, this._status, this._host);
    this.hide();
  }

  // Resolves once the host has authenticated, so the caller can run the action
  // the host refused. Rejects on a failed, cancelled or dismissed login: the
  // console reports nothing after cancel(), so an unsettled caller would leave
  // its card spinning for good.
  login(alias: string, connect: OAuthWebSocketConnector): Promise<void> {
    this._settle(new Error("Superseded by another SSH login."));
    this._title.textContent = `Interactive SSH login — ${alias}`;
    this._status.textContent = `${alias} is asking for credentials.`;
    this.show();
    const console = this._ensureConsole();
    return new Promise<void>((resolve, reject) => {
      const pending: IPendingLogin = { resolve, reject };
      this._pending = pending;
      console.start(connect, {
        ready: () => {
          if (this._pending !== pending) return;
          this._pending = undefined;
          this._status.textContent = `Signed in to ${alias}.`;
          console.complete(`Signed in to ${alias}.`);
          resolve();
        },
        failed: (message) => {
          if (this._pending !== pending) return;
          this._pending = undefined;
          this._status.textContent = message;
          console.complete(message, false);
          reject(new Error(message));
        },
        status: (message) => {
          if (this._pending === pending) this._status.textContent = message;
        },
      });
      requestAnimationFrame(() => {
        if (this._pending !== pending) return;
        this.node.scrollIntoView?.({ block: "nearest" });
        console.focus();
      });
    });
  }

  cancel(): void {
    this._console?.cancel();
    this._settle(new Error("SSH login cancelled."));
    this.hide();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._settle(new Error("SSH login dismissed."));
    this._console?.dispose();
    super.dispose();
  }

  private _ensureConsole(): ISshOperationConsole {
    if (!this._console) {
      this._console = this._consoleFactory();
      this._host.appendChild(this._console.node);
    }
    return this._console;
  }

  private _settle(reason: Error): void {
    const pending = this._pending;
    this._pending = undefined;
    pending?.reject(reason);
  }
}
