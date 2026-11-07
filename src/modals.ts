// The panel's dialogs: session detail, Add Session, Compute Hosts, Credentials
// and Run History. Each is one view, closed by the dialog's own control, with
// the view's action instead of a footer.
import { Dialog } from "@jupyterlab/apputils";
import { Panel, Widget } from "@lumino/widgets";
import { errorMessage, type IDeployment, type Schemas } from "./Common";
import { type PlaneClient } from "./PlaneClient";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import { CreateSessionForm } from "./CreateSessionForm";
import type { RemoteListWidget } from "./RebuildingWidget";
import { RunHistory } from "./RunHistory";
import { SessionDetail } from "./SessionDetail";
import { SshHosts } from "./SshHosts";
import { SshKeys } from "./SshKeys";

function openDialog(title: string, widget: Widget): Dialog<unknown> {
  widget.addClass("csWorkspaceDialog");
  return new Dialog({ title, body: widget, buttons: [], hasClose: true });
}

const launch = (dialog: Dialog<unknown>): Promise<unknown> =>
  dialog.launch().catch(() => undefined);

export class SessionModals {
  private _detailDialogs = new Set<Dialog<unknown>>();

  constructor(
    private _panel: CyberShuttlePanel,
    private _api: PlaneClient,
  ) {}

  rejectDetail(): void {
    for (const dialog of this._detailDialogs) {
      dialog.reject();
    }
  }

  private async _launchTracked(dialog: Dialog<unknown>): Promise<void> {
    this._detailDialogs.add(dialog);
    try {
      await launch(dialog);
    } finally {
      this._detailDialogs.delete(dialog);
    }
  }

  async openSession(sessionId: string): Promise<void> {
    const body = new Panel();
    body.addWidget(new SessionDetail(this._panel, sessionId));
    await this._launchTracked(openDialog("CyberShuttle Session", body));
  }

  async openCreate(
    clusters: readonly Schemas["SlurmClusterConfigResponse"][],
    deployments: readonly IDeployment[],
  ): Promise<void> {
    const body = new Panel();
    const form = new CreateSessionForm(this._api);
    body.addWidget(form);
    form.setClusters([...clusters], [...deployments]);
    const dialog = openDialog("Add Session", body);
    const show = (widget: Widget): void => {
      for (const child of body.widgets) {
        child === widget ? child.show() : child.hide();
      }
      widget.activate();
    };
    form.createRequested.connect((_sender, intent) => {
      void this._createInDialog(intent, form, body, show);
    });
    show(form);
    await this._launchTracked(dialog);
  }

  async openSshHosts(): Promise<void> {
    await this._openRefreshing("Compute Hosts", new SshHosts(this._api));
  }

  async openSshKeys(): Promise<void> {
    await this._openRefreshing("Credentials", new SshKeys(this._api));
  }

  private async _openRefreshing(
    title: string,
    widget: RemoteListWidget,
  ): Promise<void> {
    void widget.refresh();
    await launch(openDialog(title, widget));
  }

  async openRunHistory(open?: string): Promise<void> {
    await launch(openDialog("Run History", new RunHistory(this._panel, open)));
  }

  private async _createInDialog(
    request: Schemas["SessionRequest"],
    form: CreateSessionForm,
    body: Panel,
    show: (widget: Widget) => void,
  ): Promise<void> {
    form.setError("");
    form.setBusy(true);
    try {
      const session = await this._panel.actions.create(request);
      if (body.isDisposed || form.isDisposed) {
        return;
      }
      const detail = new SessionDetail(this._panel, session.sessionId);
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
