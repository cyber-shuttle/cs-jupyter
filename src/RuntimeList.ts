import { runningIcon } from "@jupyterlab/ui-components";
import { Signal } from "@lumino/signaling";
import { Widget } from "@lumino/widgets";
import type { IRuntime } from "./Common";
import type { IRuntimeUiState } from "./CyberShuttlePanel";
import { button, element } from "./dom";

export const emptyState = (): IRuntimeUiState => ({
  runtimes: [],
  logs: new Map(),
  hosts: undefined,
  loading: false,
  refreshing: false,
  updatesStatus: "",
  error: "",
  busyRuntimeIds: new Set(),
  connectingRuntimeId: undefined,
  jupyterReady: new Set(),
  signedIn: false,
  signingIn: false,
  authRequired: false,
});

export class RuntimeList extends Widget {
  readonly runtimeRequested = new Signal<this, string>(this);
  readonly createRequested = new Signal<this, void>(this);
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly signInRequested = new Signal<this, void>(this);

  private _state = emptyState();
  private _currentRuntimeId: string | undefined;
  private _canCreate = false;
  private _createUnavailableReason = "";

  constructor() {
    super();
    this.id = "cybershuttle-runtime-list";
    this.addClass("csRuntimePanel");
    this._render();
  }

  setControllerState(state: IRuntimeUiState): void {
    this._state = state;
    this._render();
  }

  setCurrentRuntimeId(id: string | undefined): void {
    this._currentRuntimeId = id;
    this._render();
  }

  setCanCreate(canCreate: boolean, unavailableReason = ""): void {
    this._canCreate = canCreate;
    this._createUnavailableReason = unavailableReason;
    this._render();
  }

  private _render(): void {
    const focusedAction = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.runtimeAction
      : undefined;
    this.node.textContent = "";
    this.node.appendChild(this._build());
    for (const element of Array.from(
      this.node.querySelectorAll<HTMLElement>("[data-runtime-action]"),
    )) {
      if (element.dataset.runtimeAction === focusedAction) element.focus();
    }
  }

  private _build(): HTMLElement {
    const launcher = document.createElement("div");
    launcher.className = "csRuntimeLauncher";

    const header = document.createElement("header");
    header.className = "jp-Launcher-sectionHeader csRuntimeLauncherHeader";
    const title = document.createElement("h2");
    title.className = "jp-Launcher-sectionTitle";
    title.textContent = "Cybershuttle";
    const actions = document.createElement("div");
    const signIn = button(
      this._state.signingIn
        ? "Signing in…"
        : this._state.authRequired
          ? "Sign in"
          : this._state.signedIn
            ? "Signed in"
            : "Sign in",
      "csTextButton csSignInButton",
    );
    signIn.disabled =
      this._state.signingIn ||
      (this._state.signedIn && !this._state.authRequired);
    signIn.onclick = () => this.signInRequested.emit(undefined);
    const sshHosts = button("SSH Hosts", "csTextButton csSshHostsButton");
    sshHosts.disabled = !this._state.signedIn || this._state.authRequired;
    sshHosts.onclick = () => this.sshHostsRequested.emit(undefined);
    actions.append(signIn, sshHosts);
    header.append(title, actions);
    launcher.appendChild(header);

    const body = document.createElement("div");
    body.className = "jp-Launcher-body";
    const content = document.createElement("div");
    content.className = "jp-Launcher-content";
    const section = document.createElement("section");
    section.className = "jp-Launcher-section csRuntimeSection";
    const sectionHeader = document.createElement("header");
    sectionHeader.className = "jp-Launcher-sectionHeader";
    const sectionTitle = document.createElement("h2");
    sectionTitle.className = "jp-Launcher-sectionTitle";
    sectionTitle.textContent = "Cybershuttle Runtimes";
    sectionHeader.append(
      runningIcon.element({ stylesheet: "launcherSection" }),
      sectionTitle,
    );
    section.appendChild(sectionHeader);

    for (const message of [
      this._createUnavailableReason,
      this._state.error,
      this._state.updatesStatus,
    ]) {
      if (message) {
        const status = document.createElement("div");
        status.className =
          message === this._state.error ? "csError" : "csStatus";
        status.textContent = message;
        section.appendChild(status);
      }
    }
    if (this._state.loading && this._state.runtimes.length === 0) {
      const status = document.createElement("div");
      status.className = "csStatus";
      status.textContent = "Loading runtimes…";
      section.appendChild(status);
    }

    const cards = document.createElement("div");
    cards.className = "jp-Launcher-cardContainer";
    for (const runtime of this._state.runtimes) {
      cards.appendChild(this._runtimeCard(runtime));
    }
    const add = button("", "jp-LauncherCard csRuntimeAddCard");
    add.ariaLabel = "Add Runtime";
    add.dataset.runtimeAction = "add-runtime";
    add.disabled =
      !this._state.signedIn ||
      this._state.authRequired ||
      !this._canCreate ||
      this._state.loading;
    add.title = this._createUnavailableReason || "Add Runtime";
    add.append(
      element("div", "+", "jp-LauncherCard-icon csRuntimeAddIcon"),
      element("div", "Add Runtime", "jp-LauncherCard-label"),
    );
    add.onclick = () => this.createRequested.emit(undefined);
    cards.appendChild(add);
    section.appendChild(cards);
    content.appendChild(section);
    body.appendChild(content);
    launcher.appendChild(body);
    return launcher;
  }

  private _runtimeCard(runtime: IRuntime): HTMLButtonElement {
    const card = button("", "jp-LauncherCard csRuntimeCard");
    const current = runtime.id === this._currentRuntimeId;
    card.ariaLabel = `${runtime.rootFolder}, ${runtime.state}${current ? ", connected" : ""}`;
    card.title = card.ariaLabel;
    card.dataset.category = "Cybershuttle Runtimes";
    card.dataset.runtimeAction = runtime.id;
    card.onclick = () => this.runtimeRequested.emit(runtime.id);
    const label = document.createElement("div");
    label.className = "jp-LauncherCard-label csRuntimeCardLabel";
    label.append(
      element("p", runtime.rootFolder, "csRuntimeCardTitle"),
      element(
        "span",
        `${runtime.sshHost} · ${runtime.resources.cores} CPU · ${runtime.resources.memoryMb} MB`,
        "csRuntimeCardMeta",
      ),
      element(
        "span",
        runtime.state,
        `csRuntimeState csRuntimeState-${runtime.state.toLowerCase()}`,
      ),
      element(
        "span",
        `Jupyter: ${this._state.jupyterReady?.has(runtime.id) ? "ready" : "pending"}`,
        "csMeta",
      ),
    );
    card.append(
      element(
        "div",
        runtime.rootFolder.slice(0, 1).toUpperCase() || "R",
        "jp-LauncherCard-icon csRuntimeCardIcon",
      ),
      label,
    );
    return card;
  }
}
