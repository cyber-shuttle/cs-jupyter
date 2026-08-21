import { Widget } from "@lumino/widgets";
import { isTerminal, type IRuntime, type RuntimeState } from "./Common";
import type { CyberShuttlePanel, IRuntimeUiState } from "./CyberShuttlePanel";
import type { IRuntimeLogTail } from "./ControlClient";
import { button, element } from "./dom";

const ACTIVE_STATES = new Set<RuntimeState>([
  "SUBMITTING",
  "QUEUED",
  "STARTING",
  "STOPPING",
]);
const STOPPABLE_STATES = new Set<RuntimeState>([
  "SUBMITTING",
  "QUEUED",
  "STARTING",
  "READY",
]);

interface IRuntimeLogView {
  open: boolean;
  scrollTop: number;
  atBottom: boolean;
}

export class RuntimeDetail extends Widget {
  private _state: IRuntimeUiState;
  private _runtime: IRuntime | undefined;
  private _logView: IRuntimeLogView | undefined;

  constructor(
    private _controller: CyberShuttlePanel,
    private _runtimeId: string,
  ) {
    super();
    this.addClass("csRuntimeDetail");
    this._state = _controller.state;
    this._controller.stateChanged.connect(this._onStateChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._controller.stateChanged.disconnect(this._onStateChanged, this);
    super.dispose();
  }

  private _onStateChanged(
    _sender: CyberShuttlePanel,
    state: IRuntimeUiState,
  ): void {
    if (
      this._state.logs.has(this._runtimeId) &&
      !state.logs.has(this._runtimeId)
    ) {
      this._logView = undefined;
    }
    this._state = state;
    this._render();
  }

  private _render(): void {
    const focusedAction = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.runtimeAction
      : undefined;
    this._captureLogView();
    const previous = this._runtime;
    this._runtime = this._state.runtimes.find(
      (runtime) => runtime.id === this._runtimeId,
    );
    if (this._runtime && previous?.state !== this._runtime.state) {
      if (!this._logView) {
        this._logView = this._defaultLogView(this._runtime);
      } else if (this._runtime.state === "READY") {
        this._logView.open = false;
      } else if (this._runtime.state === "FAILED") {
        this._logView.open = true;
      } else if (
        ACTIVE_STATES.has(this._runtime.state) &&
        (!previous || !ACTIVE_STATES.has(previous.state))
      ) {
        this._logView.open = true;
      }
    }
    this.node.textContent = "";
    this.node.appendChild(
      this._runtime
        ? this._buildRuntime(this._runtime)
        : element("div", "Waiting for live runtime state…", "csStatus"),
    );
    this._restoreLogScroll();
    for (const element of Array.from(
      this.node.querySelectorAll<HTMLElement>("[data-runtime-action]"),
    )) {
      if (element.dataset.runtimeAction === focusedAction) element.focus();
    }
  }

  private _buildRuntime(runtime: IRuntime): HTMLElement {
    const root = document.createElement("div");
    root.className = "csRoot";

    const header = document.createElement("div");
    header.className = "csRuntimeDetailHeader";
    const identity = document.createElement("div");
    identity.append(
      element("h3", runtime.sshHost, "csRuntimeDetailTitle"),
      element(
        "span",
        runtime.account || "(no project)",
        "csRuntimeDetailAccount",
      ),
      element(
        "span",
        runtime.state,
        `csRuntimeState csRuntimeState-${runtime.state.toLowerCase()}`,
      ),
    );
    const actions = document.createElement("div");
    actions.className = "csRuntimeDetailActions";
    const busy = this._state.busyRuntimeIds.has(runtime.id);
    if (isTerminal(runtime.state)) {
      // A terminal allocation cannot resume: its job, tunnel, and generation are
      // gone. Running it again means submitting a fresh one from the same form,
      // which is also where its settings are edited.
      actions.appendChild(
        this._button(
          "Run again",
          "csPrimaryButton",
          busy,
          () => void this._controller.createLike(runtime.id),
        ),
      );
    }
    if (STOPPABLE_STATES.has(runtime.state)) {
      actions.appendChild(
        this._button(
          "Stop",
          "csSecondaryButton",
          busy,
          () => void this._controller.stop(runtime.id),
        ),
      );
    }
    if (
      runtime.state === "READY" &&
      this._state.jupyterReady?.has(runtime.id)
    ) {
      if (runtime.id === this._controller.currentRuntimeId) {
        actions.appendChild(element("span", "Connected", "csPill"));
      } else {
        actions.appendChild(
          this._button(
            "Connect",
            "csPrimaryButton",
            busy || this._state.connectingRuntimeId !== undefined,
            () => void this._controller.connect(runtime.id),
          ),
        );
      }
    }
    actions.appendChild(
      this._button(
        "Delete",
        "csDangerButton",
        busy,
        () => void this._controller.remove(runtime.id),
      ),
    );
    if (busy || this._state.connectingRuntimeId === runtime.id) {
      actions.appendChild(element("span", "", "csSpinner"));
    }
    header.append(identity, actions);
    root.appendChild(header);

    const details = document.createElement("dl");
    details.className = "csRuntimeDetailGrid";
    this._field(
      details,
      "Jupyter",
      this._state.jupyterReady?.has(runtime.id) ? "ready" : "pending",
    );
    this._field(details, "Generation", runtime.generation ?? "pending");
    this._field(details, "Workspace", runtime.rootFolder);
    this._field(details, "Partition", runtime.partition);
    this._field(details, "Cores", String(runtime.resources.cores));
    this._field(details, "Memory", `${runtime.resources.memoryMb} MB`);
    this._field(details, "Walltime", `${runtime.resources.wallMinutes} min`);
    if (runtime.resources.gpuCount) {
      this._field(
        details,
        "GPU",
        `${runtime.resources.gpuCount} ${runtime.resources.gpuType || ""}`.trim(),
      );
    }
    root.appendChild(details);

    const error = runtime.error || this._state.error;
    if (error) {
      root.appendChild(element("div", error, "csError"));
    }
    if (this._state.updatesStatus) {
      root.appendChild(element("div", this._state.updatesStatus, "csStatus"));
    }
    const tail = this._state.logs.get(runtime.id);
    if (tail) {
      root.appendChild(this._runtimeLog(runtime, tail));
    }
    return root;
  }

  private _field(parent: HTMLElement, label: string, value: string): void {
    parent.append(
      element("dt", label, "csRuntimeDetailLabel"),
      element("dd", value, "csRuntimeDetailValue"),
    );
  }

  // The status of a starting allocation is the thing an owner is waiting on, so
  // it is always on screen rather than behind a disclosure, and each line is
  // dated: what matters about a stalled runtime is when it last said anything.
  private _runtimeLog(runtime: IRuntime, tail: IRuntimeLogTail): HTMLElement {
    const view = this._logView ?? this._defaultLogView(runtime);
    this._logView = view;
    const section = document.createElement("section");
    section.className = "csRuntimeLog";
    section.appendChild(element("h4", "Status", "csRuntimeLogTitle"));
    const scroller = document.createElement("div");
    scroller.className = "csRuntimeLogScroll";
    scroller.dataset.runtimeId = runtime.id;
    scroller.role = "log";
    scroller.ariaLabel = `Status for ${runtime.sshHost}`;
    scroller.setAttribute("aria-live", "polite");
    scroller.onscroll = () => {
      view.scrollTop = scroller.scrollTop;
      view.atBottom = this._atBottom(scroller);
    };
    for (const line of tail.lines) {
      const row = document.createElement("div");
      row.className = `csRuntimeLogLine csRuntimeLog-${line.stream}`;
      const at = new Date(line.at);
      const stamp = Number.isFinite(at.getTime())
        ? at.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "";
      const time = element("time", stamp, "csRuntimeLogTime");
      if (stamp) time.dateTime = line.at;
      time.title = line.stream;
      row.append(time, element("span", line.text, "csRuntimeLogText"));
      scroller.appendChild(row);
    }
    section.appendChild(scroller);
    return section;
  }

  private _defaultLogView(_runtime: IRuntime): IRuntimeLogView {
    return { open: true, scrollTop: 0, atBottom: true };
  }

  private _captureLogView(): void {
    const scroller = this.node.querySelector<HTMLElement>(
      ".csRuntimeLogScroll[data-runtime-id]",
    );
    const details = scroller?.closest("details");
    if (!scroller || !this._logView || (details && !details.open)) {
      return;
    }
    this._logView.scrollTop = scroller.scrollTop;
    this._logView.atBottom = this._atBottom(scroller);
  }

  private _restoreLogScroll(): void {
    const scroller = this.node.querySelector<HTMLElement>(
      ".csRuntimeLogScroll[data-runtime-id]",
    );
    if (scroller && this._logView) {
      this._restoreLogScroller(scroller, this._logView);
    }
  }

  private _restoreLogScroller(
    scroller: HTMLElement,
    view: IRuntimeLogView,
  ): void {
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
    control.dataset.runtimeAction = text;
    control.disabled = disabled;
    return control;
  }
}
