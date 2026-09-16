// Renders the launcher's session cards and header actions. A card's host and job
// spec sit together as one identity, apart from the rest of the layout. The
// countdown is the one figure that changes on its own, driven by a shared clock.
import { Signal } from "@lumino/signaling";
import { RebuildingWidget } from "./RebuildingWidget";
import type { ISession } from "./Common";
import {
  displayState,
  emptyState,
  type ISessionUiState,
} from "./session-ui-state";
import { button, CLOCK_GLYPH, element, notes, statePill } from "./dom";
import { getActiveSessionId } from "./session-state";
import { countsDown, remainingBadge } from "./walltime";

export class SessionList extends RebuildingWidget {
  readonly sessionRequested = new Signal<this, string>(this);
  readonly createRequested = new Signal<this, void>(this);
  readonly sshHostsRequested = new Signal<this, void>(this);
  readonly runHistoryRequested = new Signal<this, void>(this);

  private _state = emptyState();
  private _canCreate = false;
  private _createUnavailableReason = "";

  constructor() {
    super();
    this.id = "cybershuttle-session-list";
    this.addClass("csSessionPanel");
    this._render();
  }

  setState(state: ISessionUiState): void {
    this._state = state;
    this._render();
  }

  setCanCreate(canCreate: boolean, unavailableReason = ""): void {
    this._canCreate = canCreate;
    this._createUnavailableReason = unavailableReason;
    this._render();
  }

  protected _counting(): boolean {
    return this._state.sessions.some(countsDown);
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    this.node.appendChild(this._build());
  }

  private _build(): HTMLElement {
    const section = element(
      "section",
      "",
      "jp-Launcher-section csSessionSection",
    );
    const sectionHeader = element("header", "", "jp-Launcher-sectionHeader");
    const sectionTitle = element("h2", "Sessions", "jp-Launcher-sectionTitle");
    const sshHosts = button("SSH Hosts", "csTextButton csSectionHeaderButton");
    sshHosts.dataset.sessionAction = "ssh-hosts";
    sshHosts.disabled = !this._state.signedIn;
    sshHosts.onclick = () => this.sshHostsRequested.emit(undefined);
    const history = button("Run history", "csTextButton csSectionHeaderButton");
    history.dataset.sessionAction = "run-history";
    history.disabled = !this._state.signedIn;
    history.onclick = () => this.runHistoryRequested.emit(undefined);
    sectionHeader.append(
      serverRackIcon("jp-Launcher-sectionIcon csSessionSectionRack"),
      sectionTitle,
      history,
      sshHosts,
    );
    section.appendChild(sectionHeader);

    section.append(
      ...notes([
        [this._createUnavailableReason, "csStatus"],
        [this._state.error, "csError"],
        [this._state.updatesStatus, "csStatus"],
      ]),
    );
    if (this._state.loading && this._state.sessions.length === 0) {
      const status = element("div", "Loading sessions…", "csStatus");
      section.appendChild(status);
    }

    if (!this._state.signedIn) {
      section.appendChild(
        element(
          "div",
          "Sign in to see your sessions and SSH hosts.",
          "csSignedOutNotice",
        ),
      );
      return section;
    }

    const cards = element("div", "", "jp-Launcher-cardContainer");
    for (const session of this._state.sessions) {
      cards.appendChild(this._sessionCard(session));
    }
    const add = button("", "jp-LauncherCard csSessionAddCard");
    add.ariaLabel = "Add Session";
    add.dataset.sessionAction = "add-session";
    add.disabled = !this._canCreate || this._state.loading;
    add.title = this._createUnavailableReason || "Add Session";
    add.append(
      element("div", "+", "jp-LauncherCard-icon csSessionAddIcon"),
      element("div", "Add Session", "jp-LauncherCard-label"),
    );
    add.onclick = () => this.createRequested.emit(undefined);
    cards.appendChild(add);
    section.appendChild(cards);
    return section;
  }

  private _sessionCard(session: ISession): HTMLButtonElement {
    const current = session.id === getActiveSessionId();
    const state = displayState(session, this._state.busySessionIds);
    const card = button(
      "",
      `jp-LauncherCard csSessionCard${current ? " csSessionCardCurrent" : ""}`,
    );
    card.ariaLabel = `${session.sshHost}, ${state}${current ? ", current session" : ""}`;
    card.title = card.ariaLabel;
    card.dataset.category = "CyberShuttle Sessions";
    card.dataset.sessionAction = session.id;
    card.onclick = () => this.sessionRequested.emit(session.id);
    const label = element(
      "div",
      "",
      "jp-LauncherCard-label csSessionCardLabel",
    );
    const identity = element("span", "", "csSessionCardIdentity");
    identity.append(element("p", session.sshHost, "csSessionCardTitle"));
    if (session.account) {
      identity.append(element("span", session.account, "csSessionCardAccount"));
    }
    label.append(
      identity,
      statePill(state),
      ...(current ? [element("span", "Current", "csCurrentPill")] : []),
      sessionResourceRow(session),
      ...(countsDown(session) ? [countdown(session)] : []),
    );
    card.append(serverRackIcon(), label);
    return card;
  }
}

function measure(glyph: string, value: string, title: string): HTMLElement {
  const node = element("span", "", "csResourceMeasure");
  node.title = title;
  node.innerHTML = glyph;
  node.appendChild(element("span", value, "csResourceValue"));
  return node;
}

function countdown(session: ISession): HTMLElement {
  const { label, low } = remainingBadge(session, Date.now());
  const row = element(
    "span",
    "",
    `csSessionCardCountdown${low ? " csSessionCardCountdownLow" : ""}`,
  );
  row.appendChild(
    measure(CLOCK_GLYPH, `${label} left`, `${label} of walltime left`),
  );
  return row;
}

const RESOURCE_GLYPHS = {
  cpu: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="1" /><path d="M6.5 2.6v2.15M9.5 2.6v2.15M6.5 11.25v2.15M9.5 11.25v2.15M2.6 6.5h2.15M2.6 9.5h2.15M11.25 6.5h2.15M11.25 9.5h2.15" /></g></svg>`,
  gpu: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="1.9" y="4.6" width="12.2" height="7.4" rx="1.2" /><circle cx="6" cy="8.3" r="1.9" /><path d="M10.6 6.9v2.8" /></g></svg>`,
  mem: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><rect x="1.9" y="5.1" width="12.2" height="6.4" rx="1" /><path d="M5.2 5.1v6.4M8 5.1v6.4M10.8 5.1v6.4" /></g></svg>`,
};

function gigabytes(memoryMb: number): string {
  return `${Number((memoryMb / 1024).toFixed(1))}G`;
}

function sessionResourceRow(session: ISession): HTMLElement {
  const { cores, gpuCount = 0, memoryMb } = session.resources;
  const row = element("span", "", "csSessionCardMeta");
  const measures: Array<[string, string, string]> = [
    [RESOURCE_GLYPHS.cpu, String(cores), `${cores} CPU`],
    ...(gpuCount
      ? ([[RESOURCE_GLYPHS.gpu, String(gpuCount), `${gpuCount} GPU`]] as Array<
          [string, string, string]
        >)
      : []),
    [RESOURCE_GLYPHS.mem, gigabytes(memoryMb), `${gigabytes(memoryMb)} memory`],
  ];
  measures.forEach(([glyph, value, title], index) => {
    if (index > 0) {
      row.appendChild(element("span", "·", "csResourceSeparator"));
    }
    row.appendChild(measure(glyph, value, title));
  });
  return row;
}

function serverRackIcon(
  className = "jp-LauncherCard-icon csSessionCardIcon",
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
