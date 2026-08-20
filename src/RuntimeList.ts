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
  account: undefined,
});

export class RuntimeList extends Widget {
  readonly runtimeRequested = new Signal<this, string>(this);
  readonly createRequested = new Signal<this, void>(this);
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly signInRequested = new Signal<this, void>(this);
  readonly signOutRequested = new Signal<this, void>(this);

  private _state = emptyState();
  private _currentRuntimeId: string | undefined;
  private _canCreate = false;
  private _createUnavailableReason = "";
  private _accountMenuOpen = false;

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
    header.append(
      element("div", "", "csRuntimeSectionIcon"),
      title,
      this._identityControl(),
    );
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
    sectionTitle.textContent = "Runtimes";
    const sshHosts = button("SSH Hosts", "csTextButton csSshHostsButton");
    sshHosts.dataset.runtimeAction = "ssh-hosts";
    sshHosts.disabled = !this._state.signedIn || this._state.authRequired;
    sshHosts.onclick = () => this.sshHostsRequested.emit(undefined);
    sectionHeader.append(
      serverRackIcon("jp-Launcher-sectionIcon csRuntimeSectionRack"),
      sectionTitle,
      sshHosts,
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

    if (!this._state.signedIn) {
      section.appendChild(
        element(
          "div",
          "Sign in to see your runtimes and SSH hosts.",
          "csSignedOutNotice",
        ),
      );
      content.appendChild(section);
      body.appendChild(content);
      launcher.appendChild(body);
      return launcher;
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

  // Signed out this is one button; signed in it names the account and hides
  // sign-out behind a menu, so leaving is deliberate rather than one stray click.
  private _identityControl(): HTMLElement {
    const holder = element("div", "", "csIdentity");
    if (!this._state.signedIn) {
      const signIn = button(
        this._state.signingIn ? "Signing in…" : "Sign in",
        "csTextButton csSignInButton",
      );
      signIn.dataset.runtimeAction = "sign-in";
      signIn.disabled = this._state.signingIn;
      signIn.onclick = () => this.signInRequested.emit(undefined);
      holder.appendChild(signIn);
      return holder;
    }
    const trigger = button(
      this._state.account ?? "Account",
      "csTextButton csAccountButton",
    );
    trigger.dataset.runtimeAction = "account";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", String(this._accountMenuOpen));
    trigger.onclick = () => {
      this._accountMenuOpen = !this._accountMenuOpen;
      this._render();
    };
    holder.appendChild(trigger);
    if (this._accountMenuOpen) {
      const menu = element("div", "", "csAccountMenu");
      menu.setAttribute("role", "menu");
      const signOut = button("Sign out", "csAccountMenuItem");
      signOut.dataset.runtimeAction = "sign-out";
      signOut.setAttribute("role", "menuitem");
      signOut.onclick = () => {
        this._accountMenuOpen = false;
        this.signOutRequested.emit(undefined);
      };
      menu.appendChild(signOut);
      holder.appendChild(menu);
    }
    return holder;
  }

  private _runtimeCard(runtime: IRuntime): HTMLButtonElement {
    const current = runtime.id === this._currentRuntimeId;
    const card = button(
      "",
      `jp-LauncherCard csRuntimeCard${current ? " csRuntimeCardCurrent" : ""}`,
    );
    card.ariaLabel = `${runtime.sshHost}, ${runtime.state}${current ? ", current session" : ""}`;
    card.title = card.ariaLabel;
    card.dataset.category = "Cybershuttle Runtimes";
    card.dataset.runtimeAction = runtime.id;
    card.onclick = () => this.runtimeRequested.emit(runtime.id);
    const label = document.createElement("div");
    label.className = "jp-LauncherCard-label csRuntimeCardLabel";
    // The card identifies the runtime and what it costs; everything else about
    // it, including the working directory, belongs to the detail dialog a click
    // away.
    // The host and the allocation it runs under are one identity, so they sit
    // together without the gap that separates the rest of the card.
    const identity = element("span", "", "csRuntimeCardIdentity");
    identity.append(element("p", runtime.sshHost, "csRuntimeCardTitle"));
    if (runtime.account) {
      identity.append(element("span", runtime.account, "csRuntimeCardAccount"));
    }
    label.append(
      identity,
      element(
        "span",
        runtime.state,
        `csRuntimeState csRuntimeState-${runtime.state.toLowerCase()}`,
      ),
      ...(current ? [element("span", "Current", "csCurrentPill")] : []),
      runtimeResourceRow(runtime),
    );
    card.append(serverRackIcon(), label);
    return card;
  }
}

const RESOURCE_GLYPHS = {
  cpu: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1" /><path d="M6.5 2.6v2.15M9.5 2.6v2.15M6.5 11.25v2.15M9.5 11.25v2.15M2.6 6.5h2.15M2.6 9.5h2.15M11.25 6.5h2.15M11.25 9.5h2.15" /></g></svg>`,
  gpu: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="1.9" y="4.6" width="12.2" height="7.4" rx="1.2" /><circle cx="6" cy="8.3" r="1.9" /><path d="M10.6 6.9v2.8" /></g></svg>`,
  mem: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="1.9" y="5.1" width="12.2" height="6.4" rx="1" /><path d="M5.2 5.1v6.4M8 5.1v6.4M10.8 5.1v6.4" /></g></svg>`,
};

// Memory is always gigabytes so the three figures stay the same shape and the
// row survives a narrow card.
function gigabytes(memoryMb: number): string {
  return `${Number((memoryMb / 1024).toFixed(1))}G`;
}

function runtimeResourceRow(runtime: IRuntime): HTMLElement {
  const { cores, gpuCount = 0, memoryMb } = runtime.resources;
  const row = element("span", "", "csRuntimeCardMeta");
  const measures: Array<[string, string, string]> = [
    [RESOURCE_GLYPHS.cpu, String(cores), `${cores} CPU`],
    [RESOURCE_GLYPHS.gpu, String(gpuCount), `${gpuCount} GPU`],
    [RESOURCE_GLYPHS.mem, gigabytes(memoryMb), `${gigabytes(memoryMb)} memory`],
  ];
  measures.forEach(([glyph, value, label], index) => {
    if (index > 0) {
      row.appendChild(element("span", "·", "csResourceSeparator"));
    }
    const measure = element("span", "", "csResourceMeasure");
    measure.title = label;
    measure.innerHTML = glyph;
    measure.appendChild(element("span", value, "csResourceValue"));
    row.appendChild(measure);
  });
  return row;
}

// JupyterLab ships no rack icon, so this is the smallest one that still reads
// as a machine. Hairline strokes keep it as light as the glyphs beside it, and
// currentColor keeps it correct in either theme.
function serverRackIcon(
  className = "jp-LauncherCard-icon csRuntimeCardIcon",
): HTMLElement {
  const icon = element("div", "", className);
  icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="1.1">
    <rect x="4.25" y="4.5" width="15.5" height="4.4" rx="1.2" />
    <rect x="4.25" y="9.8" width="15.5" height="4.4" rx="1.2" />
    <rect x="4.25" y="15.1" width="15.5" height="4.4" rx="1.2" />
  </g>
  <g fill="currentColor">
    <circle cx="7.4" cy="6.7" r="0.7" />
    <circle cx="7.4" cy="12" r="0.7" />
    <circle cx="7.4" cy="17.3" r="0.7" />
  </g>
</svg>`;
  return icon;
}
