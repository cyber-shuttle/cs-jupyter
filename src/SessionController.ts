// Opens the JupyterLite page for a chosen session. It guards file-open and
// kernel commands so they refuse to run outside an active session. Switching
// sessions saves all open documents first, then re-reads the session from
// cs-plane.
import type { JupyterFrontEnd } from "@jupyterlab/application";
import type { Widget } from "@lumino/widgets";
import { ControlClient } from "./ControlClient";
import {
  clearSessionAccess,
  getActiveSessionId,
  loadSessionAccess,
} from "./session";

type SessionDestination = (sessionId: string, documentPath?: string) => string;

interface IDocumentContextLike {
  path?: string;
}

export class SessionController {
  private _requestedDocumentPath: string | undefined;

  constructor(
    private _app: JupyterFrontEnd,
    private _api: ControlClient,
    private _destination: SessionDestination,
    private _navigate: (url: string) => void = (url) =>
      window.location.assign(url),
  ) {}

  requestDocumentPath(path: string | undefined): void {
    this._requestedDocumentPath = path;
  }

  async select(sessionId: string, isCurrent: () => boolean): Promise<void> {
    const session = await this._api.getSession(sessionId);
    if (!isCurrent()) {
      return;
    }
    if (session.state !== "READY") {
      throw new Error("Session must be READY.");
    }
    if (session.id === getActiveSessionId()) return;
    if (!loadSessionAccess(session.id, session.seq)) {
      throw new Error("Jupyter access is not available for selection.");
    }
    const previous = getActiveSessionId();
    if (previous) {
      if (!this._app.commands.hasCommand("docmanager:save-all")) {
        throw new Error(
          "Cannot switch session because save-all is unavailable.",
        );
      }
      await this._app.commands.execute("docmanager:save-all");
      if (!isCurrent()) {
        return;
      }
      const live = await this._api.getSession(session.id);
      if (!isCurrent()) return;
      if (
        live.id !== session.id ||
        live.seq !== session.seq ||
        live.state !== "READY" ||
        !loadSessionAccess(live.id, live.seq)
      ) {
        throw new Error("Session changed before selection completed.");
      }
    }
    const documentPath =
      this._requestedDocumentPath ?? this._activeDocumentContext()?.path;
    this._requestedDocumentPath = undefined;
    if (previous && previous !== session.id) {
      clearSessionAccess(previous);
    }
    this._navigate(this._destination(session.id, documentPath));
  }

  private _activeDocumentContext(): IDocumentContextLike | undefined {
    const current = this._app.shell.currentWidget as
      | (Widget & {
          context?: IDocumentContextLike;
          content?: { context?: IDocumentContextLike };
        })
      | null;
    return current?.context ?? current?.content?.context;
  }
}

const GUARDED = new Set([
  "notebook:create-new",
  "notebook:open",
  "console:create",
  "console:open",
  "terminal:create-new",
  "terminal:open",
  "terminal:open-folder-in-terminal",
]);

function isSessionGuardedCommand(
  command: string,
  args: { readonly [key: string]: unknown } = {},
): boolean {
  if (GUARDED.has(command)) {
    return true;
  }
  if (
    ["docmanager:open", "filebrowser:open-path"].includes(command) &&
    typeof args.path === "string" &&
    args.path.toLowerCase().endsWith(".ipynb")
  ) {
    return true;
  }
  return (
    (/^notebook:/.test(command) || /^console:/.test(command)) &&
    /(?:^|:)(?:run|execute)/.test(command)
  );
}

export function installSessionCommandGuard(
  app: JupyterFrontEnd,
  controller: SessionController,
  chooserCommand: string,
): void {
  const execute = app.commands.execute.bind(app.commands);
  app.commands.execute = ((command: string, args?: any) => {
    if (!getActiveSessionId() && isSessionGuardedCommand(command, args)) {
      const path = args?.path;
      controller.requestDocumentPath(
        typeof path === "string" ? path : undefined,
      );
      return execute(chooserCommand);
    }
    return execute(command, args);
  }) as typeof app.commands.execute;
}
