import { Widget } from "@lumino/widgets";
import type { OAuthWebSocketConnector } from "./OAuthWebSocket";
import { element } from "./dom";
import {
  createSshOperationConsole,
  ISshOperationConsole,
  SshOperationConsoleFactory,
} from "./SshOperationConsole";

// Sibling of the view, never a child: RuntimeDetail rebuilds its subtree several
// times a second on the poll, which would take the terminal and the caret with it.
export class SshLoginDock extends Widget {
  private _console: ISshOperationConsole | undefined;
  private _pending: ((reason: Error) => void) | undefined;
  private _status = element("div", "", "csSshAuthStatus");

  constructor(
    private _consoleFactory: SshOperationConsoleFactory = createSshOperationConsole,
  ) {
    super();
    this.addClass("csSshAuth");
    this.addClass("csLoginDock");
    this._status.setAttribute("role", "status");
    this.node.appendChild(this._status);
    this.hide();
  }

  // Must reject on every ending but success: the console reports nothing once
  // its generation moves on, so an unsettled caller spins for good.
  login(alias: string, connect: OAuthWebSocketConnector): Promise<void> {
    this._settle(new Error("Superseded by another SSH login."));
    this._status.textContent = `${alias} is asking for credentials.`;
    this.show();
    if (!this._console) {
      this._console = this._consoleFactory();
      this.node.appendChild(this._console.node);
    }
    const session = this._console;
    return new Promise<void>((resolve, reject) => {
      this._pending = reject;
      const current = (): boolean => this._pending === reject;
      const done = (message: string, collapse: boolean): boolean => {
        if (!current()) return false;
        this._pending = undefined;
        this._status.textContent = message;
        session.complete(message, collapse);
        return true;
      };
      session.start(connect, {
        ready: () => done(`Signed in to ${alias}.`, true) && resolve(),
        failed: (message) => done(message, false) && reject(new Error(message)),
        status: (message) => {
          if (current()) this._status.textContent = message;
        },
      });
      requestAnimationFrame(() => {
        if (!current()) return;
        this.node.scrollIntoView?.({ block: "nearest" });
        session.focus();
      });
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._settle(new Error("SSH login dismissed."));
    this._console?.dispose();
    super.dispose();
  }

  private _settle(reason: Error): void {
    const reject = this._pending;
    this._pending = undefined;
    reject?.(reason);
  }
}
