import { Signal } from "@lumino/signaling";
import { describe, expect, it, vi } from "vitest";
import type { IRuntime } from "../src/Common";
import {
  ControlClient,
  type IRuntimeLogLine,
  type IRuntimeLogTail,
} from "../src/ControlClient";
import type { IRuntimeUiState } from "../src/CyberShuttlePanel";
import { RuntimeDetail } from "../src/RuntimeDetail";
import { fakeAuth, runtimeFixture, uiState } from "./fakes";

const runtimeId = "rt-012345abcdef";

const runtime = runtimeFixture({
  id: runtimeId,
  state: "QUEUED",
  rootFolder: "projects/logs",
});

function runtimeInState(state: IRuntime["state"]): IRuntime {
  return { ...runtime, state };
}

const LOG_AT = "2026-01-01T00:00:00.000Z";

function log(
  lines: Array<Partial<IRuntimeLogLine>> = [
    { stream: "status", text: "Preparing runtime" },
  ],
): IRuntimeLogTail {
  return {
    runtimeId,
    lines: lines.map((line) => ({ at: LOG_AT, ...line })) as IRuntimeLogLine[],
  };
}

/** Reads one polled list whose logs array is exactly `logs`. */
function clientFor(logs: unknown[]): ControlClient {
  return new ControlClient(
    "https://control.example.edu/api/v1",
    fakeAuth(),
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ runtimes: [], refreshing: false, logs }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as any,
  );
}

describe("runtime log tails on the polled read", () => {
  it("accepts a complete bounded tail", async () => {
    const list = await clientFor([log()]).listRuntimes();
    expect(list.logs).toEqual([log()]);
  });

  // Tails are remote process output rendered into the workspace, so the shape
  // and the bounds are a trust boundary, not a convenience.
  it.each([
    ["a foreign runtime id", { ...log(), runtimeId: "invalid" }],
    ["an unknown field", { ...log(), extra: true }],
    [
      "an unknown stream",
      { ...log(), lines: [{ stream: "other", text: "x" }] },
    ],
    [
      "an unknown line field",
      { ...log(), lines: [{ stream: "stdout", text: "x", extra: true }] },
    ],
    [
      "too many lines",
      {
        ...log(),
        lines: Array.from({ length: 101 }, () => ({
          stream: "stdout",
          text: "x",
        })),
      },
    ],
    ["no lines", { ...log(), lines: [] }],
    [
      "an oversized tail",
      {
        ...log(),
        lines: Array.from({ length: 100 }, () => ({
          stream: "stdout",
          text: "x".repeat(1000),
        })),
      },
    ],
    [
      "an oversized line",
      { ...log(), lines: [{ stream: "stderr", text: "x".repeat(4097) }] },
    ],
    [
      "an ANSI control sequence",
      { ...log(), lines: [{ stream: "stdout", text: "\u001b[31mANSI" }] },
    ],
    [
      "an embedded newline",
      { ...log(), lines: [{ stream: "stdout", text: "two\nlines" }] },
    ],
    ["a non-object", "not-an-object"],
  ])("rejects %s", async (_name, value) => {
    await expect(clientFor([value]).listRuntimes()).rejects.toThrow(
      /invalid runtime log|oversized runtime log/,
    );
  });
});

class DetailController {
  readonly stateChanged = new Signal<this, IRuntimeUiState>(this);
  readonly runAgain = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly connect = vi.fn(async () => undefined);
  currentRuntimeId: string | undefined;

  constructor(public state: IRuntimeUiState) {}

  setState(state: IRuntimeUiState): void {
    this.state = state;
    this.stateChanged.emit(state);
  }
}

function detailState(
  value: IRuntime,
  lines: Array<Partial<IRuntimeLogLine>> = [
    { stream: "status", text: "Preparing runtime" },
    { stream: "stdout", text: "plain <b>output</b>" },
    { stream: "stderr", text: "warning" },
  ],
): IRuntimeUiState {
  const stamped = lines.map((line) => ({
    at: LOG_AT,
    ...line,
  })) as IRuntimeLogLine[];
  return uiState({
    runtimes: [value],
    logs: new Map([[value.id, { runtimeId: value.id, lines: stamped }]]),
    hosts: [],
    jupyterReady: new Set(value.state === "READY" ? [value.id] : []),
  });
}

function runtimeDetail(value: IRuntime): {
  controller: DetailController;
  detail: RuntimeDetail;
} {
  const controller = new DetailController(detailState(value));
  return {
    controller,
    detail: new RuntimeDetail(controller as any, value.id),
  };
}

describe("runtime detail modal body", () => {
  it("shows complete metadata, literal accessible logs, and state actions", () => {
    const value: IRuntime = {
      ...runtimeInState("READY"),
      account: "project-a",
      error: "bounded warning",
      resources: {
        ...runtime.resources,
        cores: 4,
        memoryMb: 4096,
        wallMinutes: 60,
        gpuCount: 2,
        gpuType: "a100",
      },
    };
    const { detail } = runtimeDetail(value);
    for (const text of [
      "projects/logs",
      "delta",
      "project-a",
      "debug",
      "4",
      "4096 MB",
      "60 min",
      "2 a100",
      "bounded warning",
    ]) {
      expect(detail.node.textContent).toContain(text);
    }
    expect(
      [...detail.node.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Stop", "Connect", "Delete"]);
    const output = detail.node.querySelector<HTMLElement>("[role=log]")!;
    expect(output.ariaLabel).toBe("Status for delta");
    expect(
      [...output.querySelectorAll(".csRuntimeLogLine")].map((row) =>
        [...row.classList].find((name) => name.startsWith("csRuntimeLog-")),
      ),
    ).toEqual([
      "csRuntimeLog-status",
      "csRuntimeLog-stdout",
      "csRuntimeLog-stderr",
    ]);
    // The first column dates each line rather than repeating its stream.
    expect(
      [...output.querySelectorAll(".csRuntimeLogTime")].map((time) =>
        time.getAttribute("datetime"),
      ),
    ).toEqual([LOG_AT, LOG_AT, LOG_AT]);
    expect(output.querySelector(".csRuntimeLogTime")?.textContent).toMatch(
      /\d/,
    );
    expect(output.querySelector("b")).toBeNull();
    expect(output.textContent).toContain("plain <b>output</b>");
    detail.dispose();
  });

  it("preserves a focused runtime action across allocation and Jupyter updates", () => {
    const value = runtimeInState("READY");
    const { controller, detail } = runtimeDetail(value);
    document.body.appendChild(detail.node);
    const stop = [
      ...detail.node.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop")!;
    stop.focus();

    controller.setState(
      detailState({ ...value, updatedAt: "2026-01-01T00:00:02Z" }),
    );
    expect(document.activeElement?.textContent).toBe("Stop");

    controller.setState({
      ...detailState(value),
      jupyterReady: new Set([value.id]),
    });
    expect(document.activeElement?.textContent).toBe("Stop");
    detail.dispose();
  });

  it.each([
    // Delete is offered in every state: a stuck allocation is exactly the one an
    // owner most needs to remove.
    ["SUBMITTING", ["Stop", "Delete"]],
    ["QUEUED", ["Stop", "Delete"]],
    ["STARTING", ["Stop", "Delete"]],
    ["READY", ["Stop", "Connect", "Delete"]],
    ["STOPPING", ["Delete"]],
    ["STOPPED", ["Run again", "Delete"]],
    ["FAILED", ["Run again", "Delete"]],
  ] as const)("gates %s actions", (state, expected) => {
    const { detail } = runtimeDetail(runtimeInState(state));
    expect(
      [...detail.node.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expected);
    detail.dispose();
  });

  it("runs a finished runtime again on the runtime it is showing", () => {
    const finished = runtimeInState("STOPPED");
    const { detail, controller } = runtimeDetail(finished);
    detail.node
      .querySelector<HTMLButtonElement>('[data-runtime-action="Run again"]')!
      .click();
    expect(controller.runAgain).toHaveBeenCalledWith(finished.id);
    detail.dispose();
  });

  it("hides Connect until Linkspan Jupyter state is ready", () => {
    const ready = runtimeInState("READY");
    const controller = new DetailController(
      uiState({
        runtimes: [ready],
        logs: new Map(),
        hosts: [],
        jupyterReady: new Set<string>(),
      }),
    );
    const detail = new RuntimeDetail(controller as any, ready.id);
    expect(detail.node.textContent).not.toContain("Connect");
    detail.dispose();
  });

  it("rerenders live, preserves status scroll, and disconnects on dispose", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(50);
    const { controller, detail } = runtimeDetail({
      ...runtime,
      state: "STARTING",
    });
    const logScroll = () =>
      detail.node.querySelector<HTMLElement>(".csRuntimeLogScroll")!;
    let scroller = logScroll();
    scroller.scrollTop = 40;
    controller.setState(
      detailState({ ...runtime, state: "STARTING" }, [
        { stream: "stdout", text: "next" },
      ]),
    );
    scroller = logScroll();
    expect(scroller.scrollTop).toBe(40);

    scroller.scrollTop = 150;
    scroller.onscroll?.(new Event("scroll"));
    controller.setState(
      detailState({ ...runtime, state: "READY" }, [
        { stream: "stdout", text: "ready" },
      ]),
    );
    expect(detail.node.textContent).toContain("READY");
    expect(detail.node.querySelector("details")).toBeNull();
    expect(detail.node.querySelector(".csRuntimeLogTitle")?.textContent).toBe(
      "Status",
    );
    expect(logScroll().scrollTop).toBe(200);

    logScroll().scrollTop = 40;
    logScroll().onscroll?.(new Event("scroll"));
    controller.setState({
      ...detailState({ ...runtime, state: "STARTING" }),
      logs: new Map(),
    });
    controller.setState(
      detailState({ ...runtime, state: "STARTING" }, [
        { stream: "stdout", text: "new epoch" },
      ]),
    );
    const status = detail.node.querySelector<HTMLElement>(".csRuntimeLog")!;
    expect(status.textContent).toContain("new epoch");
    expect(status.textContent).not.toContain("ready");
    expect(logScroll().scrollTop).toBe(200);

    detail.dispose();
    controller.setState(detailState({ ...runtime, state: "FAILED" }));
    expect(detail.node.textContent).not.toContain("FAILED");
  });
});
