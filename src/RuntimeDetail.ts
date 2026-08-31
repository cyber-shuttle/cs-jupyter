import { Widget } from "@lumino/widgets";
import { isTerminal, type IRuntime } from "./Common";
import type { CyberShuttlePanel, IRuntimeUiState } from "./CyberShuttlePanel";
import type { IRuntimeLogTail } from "./ControlClient";
import { button, element, keepingFocus, notes, statePill } from "./dom";

// Where the status log was scrolled, so a re-render keeps the reader's place.
interface IRuntimeLogView {
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
    keepingFocus(this.node, () => this._rebuild());
  }

  private _rebuild(): void {
    this._captureLogView();
    const previous = this._runtime;
    this._runtime = this._state.runtimes.find(
      (runtime) => runtime.id === this._runtimeId,
    );
    if (
      this._runtime &&
      previous?.state !== this._runtime.state &&
      !this._logView
    ) {
      this._logView = this._defaultLogView();
    }
    this.node.textContent = "";
    this.node.appendChild(
      this._runtime
        ? this._buildRuntime(this._runtime)
        : element("div", "Waiting for live runtime state…", "csStatus"),
    );
    this._restoreLogScroll();
  }

  private _buildRuntime(runtime: IRuntime): HTMLElement {
    const root = element("div", "", "csRoot");

    const header = element("div", "", "csRuntimeDetailHeader");
    const identity = document.createElement("div");
    identity.append(
      element("h3", runtime.sshHost, "csRuntimeDetailTitle"),
      element(
        "span",
        runtime.account || "(no project)",
        "csRuntimeDetailAccount",
      ),
      statePill(runtime.state),
    );
    const actions = element("div", "", "csRuntimeDetailActions");
    const busy = this._state.busyRuntimeIds.has(runtime.id);
    if (isTerminal(runtime.state)) {
      // A terminal allocation cannot resume; cs-control submits a new one here.
      actions.appendChild(
        this._button(
          "Run again",
          "csPrimaryButton",
          busy,
          () => void this._controller.runAgain(runtime.id),
        ),
      );
    }
    if (!isTerminal(runtime.state) && runtime.state !== "STOPPING") {
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

    const details = element("dl", "", "csRuntimeDetailGrid");
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

    root.append(
      ...notes([
        [runtime.error || this._state.error, "csError"],
        [this._state.updatesStatus, "csStatus"],
      ]),
    );
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

  // What an owner waits on, so it is never behind a disclosure, and dated: what
  // matters about a stalled runtime is when it last said anything.
  private _runtimeLog(runtime: IRuntime, tail: IRuntimeLogTail): HTMLElement {
    const view = this._logView ?? this._defaultLogView();
    this._logView = view;
    const section = element("section", "", "csRuntimeLog");
    section.appendChild(element("h4", "Status", "csRuntimeLogTitle"));
    const scroller = element("div", "", "csRuntimeLogScroll");
    scroller.dataset.runtimeId = runtime.id;
    scroller.role = "log";
    scroller.ariaLabel = `Status for ${runtime.sshHost}`;
    scroller.setAttribute("aria-live", "polite");
    scroller.onscroll = () => {
      view.scrollTop = scroller.scrollTop;
      view.atBottom = this._atBottom(scroller);
    };
    for (const line of tail.lines) {
      const row = element(
        "div",
        "",
        `csRuntimeLogLine csRuntimeLog-${line.stream}`,
      );
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

  private _defaultLogView(): IRuntimeLogView {
    return { scrollTop: 0, atBottom: true };
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
