// Log tails are remote process output rendered straight into the workspace, so
// their shape is a trust boundary. Delete stays available in every session
// state, since a stuck session most needs removing. A session's live log is
// dropped once it stops running, since its narration has moved into the run
// record.
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, type ILogLine, type ISession } from "../src/Common";
import {
  ControlClient,
  UNCHANGED,
  type ISessionLogTail,
} from "../src/ControlClient";
import type { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import { RunReport } from "../src/RunReport";
import type { ISessionUiState } from "../src/session-ui-state";
import { SessionDetail } from "../src/SessionDetail";
import {
  ControllerFake,
  fakeAuth,
  runFixture,
  sessionFixture,
  uiState,
} from "./fakes";

const sessionId = "s-012345abcdef";

const session = sessionFixture({
  id: sessionId,
  state: "QUEUED",
  rootFolder: "projects/logs",
});

function sessionInState(state: ISession["state"]): ISession {
  return { ...session, state };
}

const LOG_AT = "2026-01-01T00:00:00.000Z";

function log(
  lines: Array<Partial<ILogLine>> = [
    { stream: "status", text: "Preparing session" },
  ],
): ISessionLogTail {
  return {
    sessionId,
    lines: lines.map((line) => ({ at: LOG_AT, ...line })) as ILogLine[],
  };
}

function clientFor(logs: unknown[]): ControlClient {
  return new ControlClient(
    "https://control.example.edu/api/v1",
    fakeAuth(),
    vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ sessions: [], logs }),
    ),
  );
}

describe("session log tails on the polled read", () => {
  it("accepts a complete bounded tail", async () => {
    const list = await clientFor([log()]).listSessions();
    if (list === UNCHANGED) {
      throw new Error("cs-control answered 304 to a first read.");
    }
    expect(list.logs).toEqual([log()]);
  });

  it("accepts a tail with no lines", async () => {
    const list = await clientFor([{ ...log(), lines: [] }]).listSessions();
    if (list === UNCHANGED) {
      throw new Error("cs-control answered 304 to a first read.");
    }
    expect(list.logs).toEqual([{ sessionId, lines: [] }]);
  });

  it.each([
    ["a foreign session id", { ...log(), sessionId: "invalid" }],
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
    await expect(clientFor([value]).listSessions()).rejects.toThrow(
      /invalid session log|oversized session log/,
    );
  });
});

function detailState(
  value: ISession,
  lines: Array<Partial<ILogLine>> = [
    { stream: "status", text: "Preparing session" },
    { stream: "stdout", text: "plain <b>output</b>" },
    { stream: "stderr", text: "warning" },
  ],
): ISessionUiState {
  const stamped = lines.map((line) => ({
    at: LOG_AT,
    ...line,
  })) as ILogLine[];
  return uiState({
    sessions: [value],
    logs: new Map([[value.id, { sessionId: value.id, lines: stamped }]]),
    jupyterReady: new Set(value.state === "READY" ? [value.id] : []),
  });
}

function sessionDetail(value: ISession): {
  controller: ControllerFake;
  detail: SessionDetail;
} {
  const controller = new ControllerFake(detailState(value));
  return {
    controller,
    detail: new SessionDetail(
      controller as unknown as CyberShuttlePanel,
      value.id,
    ),
  };
}

describe("session detail modal body", () => {
  it("shows complete metadata, literal accessible logs, and state actions", () => {
    const value: ISession = {
      ...sessionInState("READY"),
      account: "project-a",
      error: "bounded warning",
      resources: {
        ...session.resources,
        cores: 4,
        memoryMb: 4096,
        wallMinutes: 60,
        gpuCount: 2,
        gpuType: "a100",
      },
    };
    const { detail } = sessionDetail(value);
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
    const output = detail.node.querySelector<HTMLElement>("[role=log]")!;
    expect(output.ariaLabel).toBe("Status for delta");
    expect(
      [...output.querySelectorAll(".csSessionLogLine")].map((row) =>
        [...row.classList].find((name) => name.startsWith("csSessionLog-")),
      ),
    ).toEqual([
      "csSessionLog-status",
      "csSessionLog-stdout",
      "csSessionLog-stderr",
    ]);
    expect(
      [...output.querySelectorAll(".csSessionLogTime")].map((time) =>
        time.getAttribute("datetime"),
      ),
    ).toEqual([LOG_AT, LOG_AT, LOG_AT]);
    expect(output.querySelector(".csSessionLogTime")?.textContent).toMatch(
      /\d/,
    );
    expect(output.querySelector("b")).toBeNull();
    expect(output.textContent).toContain("plain <b>output</b>");
    detail.dispose();
  });

  it("preserves a focused session action across session and Jupyter updates", () => {
    const value = sessionInState("READY");
    const { controller, detail } = sessionDetail(value);
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
    ["SUBMITTING", ["Stop", "Delete"]],
    ["READY", ["Stop", "Connect", "Delete"]],
    ["STOPPING", ["Delete"]],
    ["STOPPED", ["Run again", "Delete"]],
    ["FAILED", ["Run again", "Delete"]],
  ] as const)("gates %s actions", (state, expected) => {
    const { detail } = sessionDetail(sessionInState(state));
    expect(
      [...detail.node.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expected);
    detail.dispose();
  });

  it("runs a finished session again on the session it is showing", () => {
    const finished = sessionInState("STOPPED");
    const { detail, controller } = sessionDetail(finished);
    detail.node
      .querySelector<HTMLButtonElement>('[data-session-action="Run again"]')!
      .click();
    expect(controller.actions.runAgain).toHaveBeenCalledWith(finished.id);
    detail.dispose();
  });

  it("hides Connect until Linkspan Jupyter state is ready", () => {
    const ready = sessionInState("READY");
    const controller = new ControllerFake(
      uiState({
        sessions: [ready],
        logs: new Map(),
        jupyterReady: new Set<string>(),
      }),
    );
    const detail = new SessionDetail(
      controller as unknown as CyberShuttlePanel,
      ready.id,
    );
    expect(detail.node.textContent).not.toContain("Connect");
    detail.dispose();
  });

  it("shows a relaunch's refusal over the session's stale error", () => {
    const failed: ISession = {
      ...sessionInState("FAILED"),
      error: "startup reason",
    };
    const controller = new ControllerFake(
      uiState({
        sessions: [failed],
        logs: new Map(),
        error: "new refusal",
      }),
    );
    const detail = new SessionDetail(
      controller as unknown as CyberShuttlePanel,
      failed.id,
    );
    expect(detail.node.textContent).toContain("new refusal");
    expect(detail.node.textContent).not.toContain("startup reason");
    detail.dispose();
  });

  it("rerenders live, preserves status scroll, and disconnects on dispose", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(50);
    const { controller, detail } = sessionDetail({
      ...session,
      state: "STARTING",
    });
    const logScroll = () =>
      detail.node.querySelector<HTMLElement>(".csSessionLogScroll")!;
    let scroller = logScroll();
    scroller.scrollTop = 40;
    controller.setState(
      detailState({ ...session, state: "STARTING" }, [
        { stream: "stdout", text: "next" },
      ]),
    );
    scroller = logScroll();
    expect(scroller.scrollTop).toBe(40);

    scroller.scrollTop = 150;
    controller.setState(
      detailState({ ...session, state: "READY" }, [
        { stream: "stdout", text: "ready" },
      ]),
    );
    expect(detail.node.textContent).toContain("READY");
    expect(detail.node.querySelector(".csSessionLogTitle")?.textContent).toBe(
      "Status",
    );
    expect(logScroll().scrollTop).toBe(200);

    logScroll().scrollTop = 40;
    controller.setState({
      ...detailState({ ...session, state: "STARTING" }),
      logs: new Map(),
    });
    controller.setState(
      detailState({ ...session, state: "STARTING" }, [
        { stream: "stdout", text: "new epoch" },
      ]),
    );
    const status = detail.node.querySelector<HTMLElement>(".csSessionLog")!;
    expect(status.textContent).toContain("new epoch");
    expect(status.textContent).not.toContain("ready");
    expect(logScroll().scrollTop).toBe(200);

    detail.dispose();
    controller.setState(detailState({ ...session, state: "FAILED" }));
    expect(detail.node.textContent).not.toContain("FAILED");
  });
});

describe("what belongs to a session and what belongs to its run", () => {
  it("shows no log once the session is no longer running", () => {
    const running = sessionDetail(sessionInState("READY"));
    expect(
      running.detail.node.querySelector(".csSessionLogScroll"),
    ).not.toBeNull();
    running.detail.dispose();

    for (const state of ["STOPPED", "FAILED"] as const) {
      const { detail } = sessionDetail(sessionInState(state));
      expect(detail.node.querySelector(".csSessionLogScroll")).toBeNull();
      detail.dispose();
    }
  });
});

describe("a run keeps what its session said", () => {
  it("renders the frozen log in the report", async () => {
    const report = RunReport(
      runFixture({
        logs: [
          {
            stream: "status",
            text: "Session is running",
            at: "2030-01-01T00:00:05Z",
          },
          {
            stream: "stderr",
            text: "a warning from the job",
            at: "2030-01-01T00:00:07Z",
          },
        ],
      }),
    );
    const lines = [...report.querySelectorAll(".csSessionLogLine")].map(
      (node) => node.textContent,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Session is running");
    expect(lines[1]).toContain("a warning from the job");
    expect(report.querySelector(".csSessionLog-stderr")).not.toBeNull();
  });

  it("shows no log section for a run that never said anything", async () => {
    const report = RunReport(runFixture());
    expect(report.querySelector(".csSessionLogScroll")).toBeNull();
  });
});
