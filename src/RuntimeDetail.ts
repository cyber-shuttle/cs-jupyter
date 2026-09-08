import { Widget } from "@lumino/widgets";
import { isTerminal, type IMetricSample, type IRuntime } from "./Common";
import type { CyberShuttlePanel, IRuntimeUiState } from "./CyberShuttlePanel";
import type { IRuntimeLogTail } from "./ControlClient";
import {
  button,
  element,
  keepingFocus,
  logLine,
  notes,
  sparkline,
  statePill,
} from "./dom";
import { resourceGraphs, sparklinePoints } from "./metrics";
import {
  LOW_TIME_MS,
  countsDown,
  formatRemaining,
  remainingMs,
} from "./walltime";

// Where the status log was scrolled, so a re-render keeps the reader's place.
interface IRuntimeLogView {
  scrollTop: number;
  atBottom: boolean;
}

export class RuntimeDetail extends Widget {
  private _state: IRuntimeUiState;
  private _runtime: IRuntime | undefined;
  private _logView: IRuntimeLogView | undefined;
  // Its own clock, for the same reason the list has one: a settled runtime is
  // answered 304 and emits no state to re-render from.
  private _clock: number | undefined;

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
    this._stopClock();
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
    this._syncClock();
  }

  private _stopClock(): void {
    if (this._clock !== undefined) {
      window.clearInterval(this._clock);
      this._clock = undefined;
    }
  }

  private _syncClock(): void {
    const ticking = this._runtime !== undefined && countsDown(this._runtime);
    if (ticking && this._clock === undefined) {
      this._clock = window.setInterval(() => this._render(), 1000);
    } else if (!ticking) {
      this._stopClock();
    }
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
        : element("div", "Waiting for live session state…", "csStatus"),
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
    if (countsDown(runtime)) {
      const left = remainingMs(runtime, Date.now());
      this._field(details, "Remaining", formatRemaining(left));
      details.lastElementChild?.classList.toggle(
        "csRuntimeDetailLow",
        left <= LOW_TIME_MS,
      );
    }
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
    // The card is what this session is doing now. Once it is over there is
    // nothing live to show and its report belongs to the run history, which
    // keeps every generation rather than only the last.
    const live = !isTerminal(runtime.state);
    const samples = this._state.samples.get(runtime.id);
    if (live && samples?.length) {
      root.appendChild(this._usage(runtime, samples));
    }
    const tail = live ? this._state.logs.get(runtime.id) : undefined;
    if (tail) {
      root.appendChild(this._runtimeLog(runtime, tail));
    }
    return root;
  }

  // What the allocation is actually using, against what it was given: a series
  // read on its own scale would make an idle job look busy.
  private _usage(
    runtime: IRuntime,
    samples: readonly IMetricSample[],
  ): HTMLElement {
    const section = element("section", "", "csRuntimeUsage");
    section.appendChild(element("h4", "Usage", "csRuntimeLogTitle"));
    for (const graph of resourceGraphs(runtime, samples)) {
      const row = element("div", "", "csRuntimeUsageRow");
      const latest = graph.values[graph.values.length - 1];
      row.append(
        element("span", graph.label, "csRuntimeUsageLabel"),
        sparkline(
          sparklinePoints(graph.values, 100, 24, graph.ceiling, samples.length),
        ),
        element(
          "span",
          latest === undefined ? "—" : graph.format(latest),
          "csRuntimeUsageValue",
        ),
      );
      section.appendChild(row);
    }
    return section;
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
      scroller.appendChild(logLine(line));
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
