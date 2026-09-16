// The panel's dialogs: session detail, Add Session, SSH Hosts, SSH Keys and Run history.
// Each is one view, closed by the dialog's own control, with the view's action
// instead of a footer. The login dock sits at the top of the open dialog but
// is never the dialog's child, since closing it would destroy the dock; it
// parks on the body when the dialog goes.
import { Dialog } from "@jupyterlab/apputils";
import { Panel, Widget } from "@lumino/widgets";
import {
  errorMessage,
  type ISessionCreateRequest,
  type ISshHost,
} from "./Common";
import type { ControlClient } from "./ControlClient";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import { CreateSessionForm } from "./CreateSessionForm";
import { RunHistory } from "./RunHistory";
import { SessionDetail } from "./SessionDetail";
import { SshHosts } from "./SshHosts";
import { SshKeys } from "./SshKeys";
import { SshLoginDock } from "./ssh";
import { mount } from "./dom";

function openDialog(title: string, widget: Widget): Dialog<unknown> {
  widget.addClass("csWorkspaceDialog");
  return new Dialog({ title, body: widget, buttons: [], hasClose: true });
}

export class SessionModals {
  private _detailDialogs = new Set<Dialog<unknown>>();
  private _dialogBody: Panel | undefined;
  private _loginDock: SshLoginDock | undefined;
  private _createForm: () => CreateSessionForm = () =>
    new CreateSessionForm(this._api);
  private _sshHostsWidget: () => SshHosts = () => new SshHosts(this._api);
  private _loginDockWidget: () => SshLoginDock = () => new SshLoginDock();

  constructor(
    private _panel: CyberShuttlePanel,
    private _api: ControlClient,
  ) {}

  get loginDock(): SshLoginDock {
    this._loginDock ??= this._loginDockWidget();
    mount(this._loginDock, this._dialogBody?.node ?? document.body);
    return this._loginDock;
  }

  rejectDetail(): void {
    for (const dialog of this._detailDialogs) {
      dialog.reject();
    }
  }

  dispose(): void {
    this._loginDock?.dispose();
  }

  private async _launchTracked(
    dialog: Dialog<unknown>,
    body: Panel,
  ): Promise<void> {
    this._detailDialogs.add(dialog);
    this._dialogBody = body;
    dialog.disposed.connect(() => {
      if (this._dialogBody === body) this._dialogBody = undefined;
      if (this._loginDock?.node.parentElement === body.node) {
        mount(this._loginDock, document.body);
      }
    });
    try {
      await dialog.launch().catch(() => undefined);
    } finally {
      this._detailDialogs.delete(dialog);
    }
  }

  async openSession(sessionId: string): Promise<void> {
    const body = new Panel();
    body.addWidget(new SessionDetail(this._panel, sessionId));
    await this._launchTracked(openDialog("CyberShuttle Session", body), body);
  }

  async openCreate(hosts: readonly ISshHost[]): Promise<void> {
    const body = new Panel();
    const form = this._createForm();
    body.addWidget(form);
    form.setHosts([...hosts]);
    const dialog = openDialog("Add Session", body);
    const show = (widget: Widget): void => {
      for (const child of body.widgets) {
        child === widget ? child.show() : child.hide();
      }
      widget.activate();
    };
    form.sshHostsRequested.connect(() => {
      dialog.reject();
      void this._panel.openSshHosts();
    });
    form.createRequested.connect((_sender, intent) => {
      void this._createInDialog(intent, form, body, show);
    });
    show(form);
    await this._launchTracked(dialog, body);
  }

  async openSshHosts(): Promise<void> {
    await this._openRefreshing("SSH Hosts", this._sshHostsWidget());
  }

  async openSshKeys(): Promise<void> {
    await this._openRefreshing("SSH Keys", new SshKeys(this._api));
  }

  private async _openRefreshing(
    title: string,
    widget: SshHosts | SshKeys,
  ): Promise<void> {
    void widget.refresh();
    await openDialog(title, widget)
      .launch()
      .catch(() => undefined);
  }

  async openRunHistory(): Promise<void> {
    await openDialog("Run history", new RunHistory(this._panel))
      .launch()
      .catch(() => undefined);
  }

  private async _createInDialog(
    request: ISessionCreateRequest,
    form: CreateSessionForm,
    body: Panel,
    show: (widget: Widget) => void,
  ): Promise<void> {
    form.setError("");
    form.setBusy(true);
    try {
      const session = await this._api.createSession(request);
      if (body.isDisposed || form.isDisposed) {
        return;
      }
      const detail = new SessionDetail(this._panel, session.id);
      body.addWidget(detail);
      show(detail);
    } catch (error) {
      if (!form.isDisposed) {
        form.setError(errorMessage(error));
      }
    } finally {
      if (!form.isDisposed) {
        form.setBusy(false);
      }
    }
  }
}
