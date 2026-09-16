// Renders the full detail view for one session: identity, lifecycle actions,
// usage figures and status log. A finished session's job cannot resume, so Run
// again submits a fresh one. The status log stays visible, not behind a
// disclosure, since it shows when a session last said anything.
import { RebuildingWidget } from "./RebuildingWidget";
import { isTerminal, type ISession } from "./Common";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import type { ISessionLogTail } from "./ControlClient";
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
import { sessionSummary, usagePlots } from "./metrics";
import {
  displayState,
  getActiveSessionId,
  type ISessionUiState,
} from "./session";

interface ISessionLogView {
  scrollTop: number;
  atBottom: boolean;
}

export class SessionDetail extends RebuildingWidget {
  private _state: ISessionUiState;
  private _session: ISession | undefined;
  private _logView: ISessionLogView | undefined;

  constructor(
    private _panel: CyberShuttlePanel,
    private _sessionId: string,
  ) {
    super();
    this.addClass("csSessionDetail");
    this._state = _panel.state;
    this._panel.stateChanged.connect(this._onStateChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._panel.stateChanged.disconnect(this._onStateChanged, this);
    super.dispose();
  }

  private _onStateChanged(
    _sender: CyberShuttlePanel,
    state: ISessionUiState,
  ): void {
    if (
      this._state.logs.has(this._sessionId) &&
      !state.logs.has(this._sessionId)
    ) {
      this._logView = undefined;
    }
    this._state = state;
    this._render();
  }

  protected _counting(): boolean {
    return this._session !== undefined && countsDown(this._session);
  }

  protected _rebuild(): void {
    this._captureLogView();
    this._session = this._state.sessions.find(
      (session) => session.id === this._sessionId,
    );
    this.node.textContent = "";
    this.node.appendChild(
      this._session
        ? this._buildSession(this._session)
        : element("div", "Waiting for live session state…", "csStatus"),
    );
    this._restoreLogView();
  }

  private _buildSession(session: ISession): HTMLElement {
    const root = element("div", "", "csRoot");
    const state = displayState(session, this._state.busySessionIds);

    const header = element("div", "", "csSessionDetailHeader");
    const identity = document.createElement("div");
    identity.append(
      element("h3", session.sshHost, "csSessionDetailTitle"),
      element(
        "span",
        session.account || "(no Slurm account)",
        "csSessionDetailAccount",
      ),
      statePill(state),
    );
    const actions = element("div", "", "csSessionDetailActions");
    const busy = this._state.busySessionIds.has(session.id);
    if (isTerminal(state)) {
      actions.appendChild(
        this._button(
          "Run again",
          "csPrimaryButton",
          busy,
          () => void this._panel.actions.runAgain(session.id),
        ),
      );
    }
    if (!isTerminal(state) && state !== "STOPPING") {
      actions.appendChild(
        this._button(
          "Stop",
          "csSecondaryButton",
          busy,
          () => void this._panel.actions.stop(session.id),
        ),
      );
    }
    if (session.state === "READY" && this._state.jupyterReady.has(session.id)) {
      if (session.id === getActiveSessionId()) {
        actions.appendChild(element("span", "Connected", "csPill"));
      } else {
        actions.appendChild(
          this._button(
            "Connect",
            "csPrimaryButton",
            busy || this._state.connectingSessionId !== undefined,
            () => void this._panel.actions.connect(session.id),
          ),
        );
      }
    }
    actions.appendChild(
      this._button(
        "Delete",
        "csDangerButton",
        busy,
        () => void this._panel.actions.remove(session.id),
      ),
    );
    if (busy || this._state.connectingSessionId === session.id) {
      actions.appendChild(element("span", "", "csSpinner"));
    }
    header.append(identity, actions);
    root.appendChild(header);

    const rows: Array<[string, string]> = [
      [
        "Jupyter",
        this._state.jupyterReady.has(session.id) ? "ready" : "pending",
      ],
      ["Seq", `#${session.seq}`],
      ["Workspace", session.rootFolder],
      ...sessionSummary(session),
      ["Walltime", `${session.resources.wallMinutes} min`],
    ];
    if (session.resources.gpuCount) {
      rows.push([
        "GPU",
        `${session.resources.gpuCount} ${session.resources.gpuType || ""}`.trim(),
      ]);
    }
    const samples = this._state.samples.get(session.id);
    const live = !isTerminal(state);
    root.appendChild(
      detailColumns(
        detailGridWithRemaining(rows, session),
        live && samples?.length
          ? usagePlots(session, samples, "latest")
          : undefined,
      ),
    );

    root.append(
      ...notes([
        [this._state.error || session.error || "", "csError"],
        [this._state.updatesStatus, "csStatus"],
      ]),
    );
    const tail = live ? this._state.logs.get(session.id) : undefined;
    if (tail) {
      root.appendChild(this._sessionLog(session, tail));
    }
    return root;
  }

  private _sessionLog(session: ISession, tail: ISessionLogTail): HTMLElement {
    this._logView ??= { scrollTop: 0, atBottom: true };
    const { section, scroller } = logSection(tail.lines);
    scroller.dataset.sessionId = session.id;
    scroller.ariaLabel = `Status for ${session.sshHost}`;
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

  private _captureLogView(): void {
    const scroller = this._logScroller();
    if (!scroller) {
      return;
    }
    this._logView!.scrollTop = scroller.scrollTop;
    this._logView!.atBottom = this._atBottom(scroller);
  }

  private _restoreLogView(): void {
    const scroller = this._logScroller();
    if (!scroller) {
      return;
    }
    const view = this._logView!;
    scroller.scrollTop = view.atBottom ? scroller.scrollHeight : view.scrollTop;
  }

  private _atBottom(scroller: HTMLElement): boolean {
    return (
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2
    );
  }

  private _button(
    text: string,
    className: string,
    disabled: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const control = button(text, className, onClick);
    control.dataset.sessionAction = text;
    control.disabled = disabled;
    return control;
  }
}
