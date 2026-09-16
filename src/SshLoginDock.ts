// Attached to document.body, never to the session detail dialog, so closing
// that dialog cannot destroy it. Stop and Delete reject the detail dialog to
// raise their own confirmation, which disposes its Lumino children. login must
// reject on every ending but success, since the console stops reporting once
// its generation moves on.
import { Widget } from "@lumino/widgets";
import type { OAuthWebSocketConnector } from "./OAuthWebSocket";
import { element } from "./dom";
import {
  ISshOperationConsole,
  SshOperationConsole,
  SshOperationConsoleFactory,
} from "./SshOperationConsole";

export class SshLoginDock extends Widget {
  private _console: ISshOperationConsole | undefined;
  private _pending: ((reason: Error) => void) | undefined;
  private _status = element("div", "", "csSshAuthStatus");

  constructor(
    private _consoleFactory: SshOperationConsoleFactory = () =>
      new SshOperationConsole(),
  ) {
    super();
    this.addClass("csSshLoginDock");
    this._status.setAttribute("role", "status");
    this.node.appendChild(this._status);
    this.hide();
  }

  login(alias: string, connect: OAuthWebSocketConnector): Promise<void> {
    this._settle(new Error("Superseded by another SSH login."));
    this._status.textContent = `${alias} is asking for credentials.`;
    this.show();
    if (!this._console) {
      this._console = this._consoleFactory();
      this.node.appendChild(this._console.node);
    }
    const console = this._console;
    return new Promise<void>((resolve, reject) => {
      this._pending = reject;
      const current = (): boolean => this._pending === reject;
      const done = (message: string): boolean => {
        if (!current()) return false;
        this._pending = undefined;
        this._status.textContent = message;
        console.complete(message);
        this.hide();
        return true;
      };
      console.start(connect, {
        ready: () => done(`Signed in to ${alias}.`) && resolve(),
        failed: (message) => done(message) && reject(new Error(message)),
        status: (message) => {
          if (current()) this._status.textContent = message;
        },
      });
      requestAnimationFrame(() => {
        if (!current()) return;
        this.node.scrollIntoView?.({ block: "nearest" });
        console.focus();
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
