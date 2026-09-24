// Renders the full detail view for one session: identity, lifecycle actions,
// usage figures and status log. A finished session's job cannot resume, so Run
// again submits a fresh one. The status log stays visible, not behind a
// disclosure, since it shows when a session last said anything.
import { PanelBoundWidget } from "./RebuildingWidget";
import { isTerminal, TUNNEL_MODE_LABEL, type ISession } from "./Common";
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
    if (
      this._state.logs.has(this._sessionId) &&
      !state.logs.has(this._sessionId)
    ) {
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
      (session) => session.id === this._sessionId,
    );
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
    const state = displayState(session, this._state.busySessionIds);

    const header = element("div", "", "csSessionDetailHeader");
    const identity = element("div");
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
      [
        "Tunnel",
        session.tunnelModes.map((mode) => TUNNEL_MODE_LABEL[mode]).join(" + "),
      ],
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

    if (state === "STOPPING") {
      const stopping = element("div", "", "csStatus csStopping");
      stopping.append(
        element("span", "", "csSpinner"),
        element("span", `Session ${session.sshHost} is stopping...`),
      );
      root.appendChild(stopping);
    }
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
    scroller.setAttribute("aria-label", `Status for ${session.sshHost}`);
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
