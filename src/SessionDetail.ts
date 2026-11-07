// Renders the full detail view for one session: identity, lifecycle actions,
// usage figures and status log. The status log stays visible, not behind a
// disclosure, since it shows when a session last said anything.
import { PanelBoundWidget } from "./RebuildingWidget";
import { isRunning, type ISession } from "./Common";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import type { ISessionLogTail } from "./PlaneClient";
import type { SessionActions } from "./session-actions";
import {
  button,
  countsDown,
  detailColumns,
  detailGridWithRemaining,
  element,
  logSection,
  notes,
  statePill,
} from "./dom";
import { sessionSummary, usagePlots } from "./usage";
import {
  getActiveSessionId,
  type ISessionUiState,
  sessionTitle,
} from "./session";

interface ISessionLogView {
  scrollTop: number;
  atBottom: boolean;
}

export class SessionDetail extends PanelBoundWidget {
  private _session: ISession | undefined;
  private _logView: ISessionLogView | undefined;

  constructor(
    panel: CyberShuttlePanel,
    private _sessionId: string,
  ) {
    super(panel);
    this.addClass("csSessionDetail");
    this._render();
  }

  protected _onStateChanged(
    sender: CyberShuttlePanel,
    state: ISessionUiState,
  ): void {
    const run = this._session?.runs[0].processId;
    if (run && this._state.logs.has(run) && !state.logs.has(run)) {
      this._logView = undefined;
    }
    super._onStateChanged(sender, state);
  }

  protected _counting(): boolean {
    return this._session !== undefined && countsDown(this._session);
  }

  protected _rebuild(): void {
    const before = this._logScroller();
    if (before) {
      this._logView = {
        scrollTop: before.scrollTop,
        atBottom:
          before.scrollHeight - before.scrollTop - before.clientHeight <= 2,
      };
    }
    this._session = this._state.sessions.find(
      (session) => session.sessionId === this._sessionId,
    );
    this._logIds.clear();
    if (this._session) this._logIds.add(this._session.runs[0].processId);
    this.node.textContent = "";
    this.node.appendChild(
      this._session
        ? this._buildSession(this._session)
        : element("div", "Waiting for live session state…", "csStatus"),
    );
    const after = this._logScroller();
    if (after) {
      const view = this._logView!;
      after.scrollTop = view.atBottom ? after.scrollHeight : view.scrollTop;
    }
  }

  private _buildSession(session: ISession): HTMLElement {
    const root = element("div", "", "csRoot");
    const title = sessionTitle(this._state, session);

    const header = element("div", "", "csSessionDetailHeader");
    const identity = element("div");
    identity.append(
      element("h3", title, "csSessionDetailTitle"),
      element(
        "span",
        session.account || "(no Slurm account)",
        "csSessionDetailAccount",
      ),
      statePill(session.state),
    );
    const actions = element("div", "", "csSessionDetailActions");
    actions.append(
      ...lifecycleButtons(session, this._state, this._panel.actions),
    );
    if (
      isRunning(session.state) &&
      this._state.jupyterReady.has(session.sessionId) &&
      session.sessionId === getActiveSessionId()
    ) {
      actions.appendChild(element("span", "Connected", "csPill"));
    }
    if (
      this._state.busySessionIds.has(session.sessionId) ||
      this._state.connectingSessionId === session.sessionId
    ) {
      actions.appendChild(element("span", "", "csSpinner"));
    }
    header.append(identity, actions);
    root.appendChild(header);

    const rows: Array<[string, string]> = [
      [
        "Jupyter",
        this._state.jupyterReady.has(session.sessionId) ? "ready" : "pending",
      ],
      ...sessionSummary(session),
      ["Walltime", `${session.resources.wallMinutes} min`],
    ];
    if (session.resources.gpuCount) {
      rows.push(["GPU", String(session.resources.gpuCount)]);
    }
    const samples = this._state.samples.get(session.sessionId);
    root.appendChild(
      detailColumns(
        detailGridWithRemaining(rows, session),
        session.live && samples?.length
          ? usagePlots(session, samples)
          : undefined,
      ),
    );

    root.append(
      ...notes([
        [this._state.error || session.runs[0].error || "", "csError"],
        [this._state.updatesStatus, "csStatus"],
      ]),
    );
    const tail = session.live
      ? this._state.logs.get(session.runs[0].processId)
      : undefined;
    if (tail) {
      root.appendChild(this._sessionLog(session, tail));
    }
    return root;
  }

  private _sessionLog(session: ISession, tail: ISessionLogTail): HTMLElement {
    this._logView ??= { scrollTop: 0, atBottom: true };
    const { section, scroller } = logSection(tail.lines);
    scroller.dataset.sessionId = session.sessionId;
    scroller.setAttribute(
      "aria-label",
      `Status for ${sessionTitle(this._state, session)}`,
    );
    scroller.setAttribute("aria-live", "polite");
    return section;
  }

  private _logScroller(): HTMLElement | null {
    return this._logView
      ? this.node.querySelector<HTMLElement>(
          ".csSessionLogScroll[data-session-id]",
        )
      : null;
  }
}

export function lifecycleButtons(
  session: ISession,
  state: ISessionUiState,
  actions: SessionActions,
): HTMLButtonElement[] {
  const { sessionId } = session;
  const busy = state.busySessionIds.has(sessionId);
  const control = (
    label: string,
    className: string,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement => {
    const each = button(label, className, onClick);
    each.dataset.sessionAction = `${label}:${sessionId}`;
    each.disabled = disabled;
    return each;
  };
  const buttons = [
    session.live
      ? control(
          "Stop",
          "csSecondaryButton",
          busy,
          () => void actions.stop(sessionId),
        )
      : control(
          "Start",
          "csPrimaryButton",
          busy,
          () => void actions.start(sessionId),
        ),
  ];
  if (
    isRunning(session.state) &&
    state.jupyterReady.has(sessionId) &&
    sessionId !== getActiveSessionId()
  ) {
    buttons.push(
      control(
        "Connect",
        "csPrimaryButton",
        busy || state.connectingSessionId !== undefined,
        () => void actions.connect(sessionId),
      ),
    );
  }
  return buttons;
}
