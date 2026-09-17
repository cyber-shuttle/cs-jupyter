// Stores each session's JupyterLab layout as a file in the session's own home
// through its contents API, so the layout follows the session across devices
// and restarts instead of living in one browser slot. Without a selected
// session there is nothing to keep, and every call is a no-op.
import type { ServerConnection, Workspace } from "@jupyterlab/services";
import { Drive } from "@jupyterlab/services";

const WORKSPACES_DIR = ".cybershuttle/workspaces";

export class RemoteWorkspaces implements Workspace.IManager {
  private _drive: Drive;
  private _ready: Promise<void> | undefined;

  constructor(
    readonly serverSettings: ServerConnection.ISettings,
    private _enabled: boolean,
  ) {
    this._drive = new Drive({ serverSettings });
  }

  async fetch(id: string): Promise<Workspace.IWorkspace> {
    const empty = { data: {}, metadata: { id } };
    if (!this._enabled) return empty;
    try {
      const model = await this._drive.get(path(id), {
        content: true,
        type: "file",
        format: "text",
      });
      return { ...JSON.parse(model.content as string), metadata: { id } };
    } catch {
      return empty;
    }
  }

  async save(id: string, workspace: Workspace.IWorkspace): Promise<void> {
    if (!this._enabled) return;
    await this._ensureDir();
    await this._drive.save(path(id), {
      type: "file",
      format: "text",
      content: JSON.stringify(workspace),
    });
  }

  async remove(id: string): Promise<void> {
    if (this._enabled) await this._drive.delete(path(id)).catch(() => {});
  }

  async list(): Promise<{ ids: string[]; values: Workspace.IWorkspace[] }> {
    return { ids: [], values: [] };
  }

  private _ensureDir(): Promise<void> {
    this._ready ??= (async () => {
      for (const dir of [".cybershuttle", WORKSPACES_DIR]) {
        await this._drive.save(dir, { type: "directory" }).catch(() => {});
      }
    })();
    return this._ready;
  }
}

function path(id: string): string {
  return `${WORKSPACES_DIR}/${encodeURIComponent(id)}.json`;
}
