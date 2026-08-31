import type { JupyterFrontEnd } from "@jupyterlab/application";
import type { Widget } from "@lumino/widgets";
import { ControlClient } from "./ControlClient";
import { clearRuntimeAccess, loadRuntimeAccess } from "./runtime-access";
import { getActiveRuntimeId } from "./runtime-state";
import { selectedRuntime } from "./runtime-ui";

export type RuntimeDestination = (
  runtimeId: string,
  generation: string,
  documentPath?: string,
) => string;

interface IDocumentContextLike {
  path?: string;
}

export class RuntimeController {
  private _requestedDocumentPath: string | undefined;

  constructor(
    private _app: JupyterFrontEnd,
    private _api: ControlClient = new ControlClient(),
    private _destination: RuntimeDestination,
    private _navigate: (url: string) => void = (url) =>
      window.location.assign(url),
    readonly currentRuntimeId = getActiveRuntimeId(),
  ) {}

  requestDocumentPath(path: string | undefined): void {
    this._requestedDocumentPath = path;
  }

  async select(
    runtimeId: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const runtime = await this._api.getRuntime(runtimeId);
    if (!isCurrent()) {
      return;
    }
    if (runtime.state !== "READY") {
      throw new Error("Runtime must remain READY.");
    }
    if (
      runtime.id === this.currentRuntimeId &&
      runtime.generation === selectedRuntime()?.generation
    )
      return;
    if (!loadRuntimeAccess(runtime.id, runtime.generation)) {
      throw new Error("Jupyter access is not available for selection.");
    }
    const previous = this.currentRuntimeId;
    if (previous) {
      if (!this._app.commands.hasCommand("docmanager:save-all")) {
        throw new Error(
          "Cannot switch runtime because save-all is unavailable.",
        );
      }
      await this._app.commands.execute("docmanager:save-all");
      if (!isCurrent()) {
        return;
      }
      // The save is an unbounded gap, so the runtime is re-read across it.
      const live = await this._api.getRuntime(runtime.id);
      if (!isCurrent()) return;
      if (
        live.id !== runtime.id ||
        live.generation !== runtime.generation ||
        live.state !== "READY" ||
        !loadRuntimeAccess(live.id, live.generation)
      ) {
        throw new Error("Runtime changed before selection completed.");
      }
    }
    const documentPath =
      this._requestedDocumentPath ?? this._activeDocumentContext()?.path;
    this._requestedDocumentPath = undefined;
    if (previous && previous !== runtime.id) {
      clearRuntimeAccess(previous);
    }
    this._navigate(
      this._destination(runtime.id, runtime.generation, documentPath),
    );
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

export function isRuntimeGuardedCommand(
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

export function installRuntimeCommandGuard(
  app: JupyterFrontEnd,
  controller: RuntimeController,
  chooserCommand = "@cybershuttle/jupyter:select-runtime",
): void {
  const execute = app.commands.execute.bind(app.commands);
  app.commands.execute = ((command: string, args?: any) => {
    if (
      !controller.currentRuntimeId &&
      isRuntimeGuardedCommand(command, args)
    ) {
      const path = args?.path;
      controller.requestDocumentPath(
        typeof path === "string" ? path : undefined,
      );
      return execute(chooserCommand);
    }
    return execute(command, args);
  }) as typeof app.commands.execute;
}
