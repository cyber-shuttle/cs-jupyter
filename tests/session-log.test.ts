// Log tails are remote process output rendered into JupyterLab as text. A
// session's live log is dropped once it stops running, since its narration
// has moved into the run history.
import { describe, expect, it, vi } from "vitest";
import type { ISession } from "../src/Common";
import { RunReport } from "../src/RunHistory";
import type { ISessionUiState } from "../src/session";
import { SessionDetail } from "../src/SessionDetail";
import {
  clientFor,
  logTail,
  PanelStateFake,
  PROCESS_ID,
  runFixture,
  sessionFixture,
  uiState,
} from "./fakes";

const sessionInState = (state: ISession["state"], live = true): ISession =>
  sessionFixture({ state, live });

const LOG_AT = "2026-01-01T00:00:00.000Z";

const status = (log: string | null = "Preparing session") => ({
  processStatusId: "9f8e7d6c-5b4a-4392-8172-6a5b4c3d2e1f",
  processId: PROCESS_ID,
  status: "SUBMITTED",
  log,
  timestamp: Date.parse(LOG_AT),
});

const readTail = (value: unknown) =>
  clientFor(value).getSessionLogs(PROCESS_ID);

describe("session statuses on the polled read", () => {
  it("narrates each status by its log, else its state", async () => {
    expect(await readTail([status(), status(null)])).toEqual(
      logTail(PROCESS_ID, [
        { text: "Preparing session", at: LOG_AT },
        { text: "SUBMITTED", at: LOG_AT },
      ]),
    );
  });
});

function detailState(
  value: ISession,
  texts = ["Preparing session", "plain <b>output</b>"],
): ISessionUiState {
  const lines = texts.map((text) => ({ text, at: LOG_AT }));
  return uiState({
    sessions: [value],
    logs: new Map([[PROCESS_ID, logTail(PROCESS_ID, lines)]]),
    jupyterReady: new Set(value.state === "READY" ? [value.sessionId] : []),
  });
}

function sessionDetail(value: ISession): {
  fake: PanelStateFake;
  detail: SessionDetail;
} {
  const fake = new PanelStateFake(detailState(value));
  return {
    fake,
    detail: new SessionDetail(fake as never, value.sessionId),
  };
}

describe("session detail modal body", () => {
  it("shows complete metadata, literal accessible logs, and state actions", () => {
    const value = sessionFixture(
      {
        resources: { cores: 4, memoryMb: 4096, wallMinutes: 60, gpuCount: 2 },
      },
      { error: "bounded warning" },
    );
    const { detail } = sessionDetail(value);
    for (const text of [
      "hpc-a",
      "project-a",
      "debug",
      "4",
      "4096 MB",
      "60 min",
      "bounded warning",
    ]) {
      expect(detail.node.textContent).toContain(text);
    }
    const output = detail.node.querySelector<HTMLElement>("[role=log]")!;
    expect(output.ariaLabel).toBe("Status for hpc-a · JupyterLab");
    expect(
      [...output.querySelectorAll(".csSessionLogTime")].map((time) =>
        time.getAttribute("datetime"),
      ),
    ).toEqual([LOG_AT, LOG_AT]);
    expect(output.querySelector(".csSessionLogTime")?.textContent).toMatch(
      /\d/,
    );
    expect(output.querySelector("b")).toBeNull();
    expect(output.textContent).toContain("plain <b>output</b>");
    detail.dispose();
  });

  it.each([
    ["CREATED", true, ["Stop"]],
    ["SUBMITTED", true, ["Stop"]],
    ["RUNNING", true, ["Stop"]],
    ["READY", true, ["Stop", "Connect"]],
    ["CANCELLED", false, ["Start"]],
    ["FAILED", false, ["Start"]],
    ["COMPLETED", false, ["Start"]],
  ] as const)("gates %s (live %s) actions", (state, live, expected) => {
    const { detail } = sessionDetail(sessionFixture({ state, live }));
    expect(
      [...detail.node.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(expected);
    detail.dispose();
  });

  it("hides Connect until Linkspan Jupyter state is ready", () => {
    const ready = sessionInState("READY");
    const fake = new PanelStateFake(
      uiState({
        sessions: [ready],
        logs: new Map(),
        jupyterReady: new Set<string>(),
      }),
    );
    const detail = new SessionDetail(fake as never, ready.sessionId);
    expect(detail.node.textContent).not.toContain("Connect");
    detail.dispose();
  });

  it("rerenders live, preserves status scroll, and disconnects on dispose", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(50);
    const { fake, detail } = sessionDetail(sessionInState("RUNNING"));
    const logScroll = () =>
      detail.node.querySelector<HTMLElement>(".csSessionLogScroll")!;
    let scroller = logScroll();
    scroller.scrollTop = 40;
    fake.setState(detailState(sessionInState("RUNNING"), ["next"]));
    scroller = logScroll();
    expect(scroller.scrollTop).toBe(40);

    scroller.scrollTop = 150;
    fake.setState(detailState(sessionInState("READY"), ["ready"]));
    expect(detail.node.textContent).toContain("READY");
    expect(detail.node.querySelector(".csSessionLogTitle")?.textContent).toBe(
      "Status",
    );
    expect(logScroll().scrollTop).toBe(200);

    logScroll().scrollTop = 40;
    fake.setState({
      ...detailState(sessionInState("RUNNING")),
      logs: new Map(),
    });
    fake.setState(detailState(sessionInState("RUNNING"), ["new epoch"]));
    const status = detail.node.querySelector<HTMLElement>(".csSessionLog")!;
    expect(status.textContent).toContain("new epoch");
    expect(status.textContent).not.toContain("ready");
    expect(logScroll().scrollTop).toBe(200);

    detail.dispose();
    fake.setState(detailState(sessionInState("FAILED")));
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

    for (const state of ["CANCELLED", "FAILED"] as const) {
      const { detail } = sessionDetail(sessionInState(state, false));
      expect(detail.node.querySelector(".csSessionLogScroll")).toBeNull();
      detail.dispose();
    }
  });
});

describe("a run keeps what its session said", () => {
  it("renders the frozen log in the report", async () => {
    const report = RunReport(runFixture(), [
      { text: "Session is running", at: "2030-01-01T00:00:05Z" },
      { text: "a warning from the job", at: "2030-01-01T00:00:07Z" },
    ]);
    const lines = [...report.querySelectorAll(".csSessionLogLine")].map(
      (node) => node.textContent,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Session is running");
    expect(lines[1]).toContain("a warning from the job");
  });
});
