// Session card and list rendering, where a session is the launch and
// connection to a Jupyter server through Linkspan. Cards render inside the
// launcher's own section markup, sharing its scrollable container. The card
// contract covers only host, resources and state; other facts are asserted
// elsewhere.
import type { ReadonlyPartialJSONObject } from "@lumino/coreutils";
import { describe, expect, it, vi } from "vitest";
import { CyberShuttlePanel } from "../src/CyberShuttlePanel";
import type { ISessionUiState } from "../src/session";
import type { ISession } from "../src/Common";
import type { ISessionLogTail } from "../src/ControlClient";
import { SessionController } from "../src/SessionController";
import {
  cacheSessionAccess,
  clearSessionAccess,
  loadSessionAccess,
} from "../src/session";
import { setActiveSessionId } from "../src/session";
import { CyberShuttleHeader } from "../src/CyberShuttlePanel";
import { SessionList } from "../src/SessionList";
import {
  accessFixture,
  acceptDialog,
  controlFake,
  pollPanel,
  sessionFixture,
  sessionListFixture,
  uiState,
} from "./fakes";

const first = sessionFixture({
  id: "s-111111111111",
  account: "project-a",
  rootFolder: "projects/one",
});
const second: ISession = {
  ...first,
  id: "s-222222222222",
  rootFolder: "projects/two",
};
const active: ISession = {
  ...first,
  id: "s-333333333333",
  rootFolder: "projects/active",
};
const hiddenLog: ISessionLogTail = {
  sessionId: first.id,
  lines: [
    { stream: "status", text: "Preparing session", at: "2026-01-01T00:00:00Z" },
  ],
};

function setSessions(
  list: SessionList,
  sessions: ISession[],
  logs: ISessionUiState["logs"] = new Map(),
): void {
  list.setState(
    uiState({
      sessions,
      logs,
      jupyterReady: new Set(sessions.map((session) => session.id)),
      signedIn: true,
    }),
  );
}

async function emitSessions(
  panel: CyberShuttlePanel,
  sessions: ISession[],
): Promise<void> {
  (panel as any)._api.listSessions.mockResolvedValue(
    sessionListFixture(sessions),
  );
  await pollPanel(panel);
}

function harness(
  sessions: ISession[],
  getSession: (id: string) => Promise<ISession>,
  currentSessionId?: string,
) {
  setActiveSessionId(currentSessionId);
  const navigate = vi.fn();
  const execute = vi.fn<
    (command: string, args?: ReadonlyPartialJSONObject) => Promise<void>
  >(async () => undefined);
  const app = {
    commands: { execute, hasCommand: vi.fn(() => true) },
    shell: { currentWidget: null },
  };
  const api = controlFake({
    listSessions: vi.fn(async () => sessionListFixture(sessions)),
    getSession: vi.fn(getSession),
    stopSession: vi.fn(async () => first),
    getSessionAccess: vi.fn(async (id: string) => accessFixture(id, 1)),
  });
  sessionStorage.clear();
  for (const session of sessions) {
    cacheSessionAccess(accessFixture(session.id, session.seq));
  }
  const controller = new SessionController(
    app as any,
    api as any,
    (id) => `/selected/${id}`,
    navigate,
  );
  const panel = new CyberShuttlePanel(api as any, controller);
  void panel.signIn();
  return { panel, api, navigate, execute };
}

async function ready(panel: CyberShuttlePanel): Promise<void> {
  await vi.waitFor(() =>
    expect(panel.node.querySelectorAll(".csSessionCard")).toHaveLength(2),
  );
}

describe("serialized session selection", () => {
  it("renders native session cards and opens their live detail modal", async () => {
    const { panel } = harness(
      [first, { ...second, state: "FAILED" }],
      async (id) => (id === first.id ? first : second),
    );
    const openSession = vi
      .spyOn(panel.modals, "openSession")
      .mockResolvedValue(undefined);
    await ready(panel);
    const cards =
      panel.node.querySelectorAll<HTMLButtonElement>(".jp-LauncherCard");
    expect([
      cards.length,
      [...cards].slice(0, 2).every((card) => card.tagName === "BUTTON"),
      cards[0].ariaLabel?.includes("delta, READY"),
      cards[1].ariaLabel?.includes("FAILED"),
      cards[2].classList.contains("csSessionAddCard"),
      cards[2].textContent?.includes("Add Session"),
    ]).toEqual([3, true, true, true, true, true]);
    expect(
      [...panel.node.querySelectorAll("h2")].map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Sessions"]);
    expect(
      [...panel.header.node.querySelectorAll("h2")].map((h) =>
        h.textContent?.trim(),
      ),
    ).toEqual(["CyberShuttle"]);
    expect(
      panel.node.querySelector(
        ".jp-Launcher-section.csSessionSection > .jp-Launcher-cardContainer",
      ),
    ).not.toBeNull();
    cards[0].click();
    expect(openSession).toHaveBeenCalledWith(first.id);
    panel.dispose();
  });

  it("emits session, Add Session, and SSH Hosts card actions once", () => {
    const list = new SessionList();
    const sessionRequested = vi.fn();
    const createRequested = vi.fn();
    const sshHostsRequested = vi.fn();
    list.sessionRequested.connect((_sender, id) => sessionRequested(id));
    list.createRequested.connect(createRequested);
    list.sshHostsRequested.connect(sshHostsRequested);
    list.setCanCreate(true);
    setSessions(list, [first], new Map([[first.id, hiddenLog]]));
    expect(list.node.textContent).not.toContain("Preparing session");
    document.body.appendChild(list.node);
    list.node.querySelector<HTMLButtonElement>(".csSessionCard")!.focus();
    setSessions(list, [{ ...first }]);
    expect(document.activeElement?.getAttribute("aria-label")).toContain(
      "delta",
    );

    list.node.querySelector<HTMLButtonElement>(".csSessionCard")!.click();
    list.node.querySelector<HTMLButtonElement>(".csSessionAddCard")!.click();
    [...list.node.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "SSH Hosts")!
      .click();

    expect([
      sessionRequested.mock.calls,
      createRequested.mock.calls.length,
      sshHostsRequested.mock.calls.length,
    ]).toEqual([[[first.id]], 1, 1]);
    list.dispose();
  });

  it("does not navigate when the panel closes before selection resolves", async () => {
    window.history.replaceState({}, "", "/gateway/lab");
    const pending = Promise.withResolvers<ISession>();
    const { panel, navigate } = harness([first, second], () => pending.promise);
    await ready(panel);

    void panel.actions.connect(first.id);
    expect(panel.state.connectingSessionId).toBe(first.id);

    panel.dispose();
    pending.resolve(first);
    await pending.promise;
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not resume an in-flight connect after signing out", async () => {
    window.history.replaceState({}, "", "/gateway/lab");
    const pending = Promise.withResolvers<ISession>();
    const { panel, navigate } = harness([first, second], () => pending.promise);
    await ready(panel);

    void panel.actions.connect(first.id);
    expect(panel.state.connectingSessionId).toBe(first.id);
    expect(panel.state.busySessionIds.size).toBeGreaterThan(0);

    panel.signOut();
    expect(panel.state.connectingSessionId).toBeUndefined();
    expect(panel.state.busySessionIds.size).toBe(0);

    pending.resolve(first);
    await pending.promise;
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(panel.state.error).toBe("");
  });

  it.each(["target access", "target select", "save-all"] as const)(
    "retains the active session when %s fails",
    async (failure) => {
      window.history.replaceState(
        {},
        "",
        `/lite/lab/?session=${active.id}&seq=${active.seq}`,
      );
      const { panel, api, navigate, execute } = harness(
        [first, second],
        async (id) => (id === first.id ? first : second),
        active.id,
      );
      cacheSessionAccess(accessFixture(active.id, active.seq));
      await ready(panel);
      if (failure === "target access") {
        clearSessionAccess(first.id);
        api.getSessionAccess.mockRejectedValueOnce(
          new Error("target access failed"),
        );
      } else if (failure === "target select") {
        api.getSession.mockRejectedValueOnce(new Error("target select failed"));
      } else {
        execute.mockRejectedValueOnce(new Error("save failed"));
      }

      await panel.actions.connect(first.id);

      expect(loadSessionAccess(active.id, active.seq)).toBeDefined();
      expect(navigate).not.toHaveBeenCalled();
      panel.dispose();
    },
  );

  it("names the access failure instead of a generic one when the target leaves READY mid-read", async () => {
    const { panel, api, navigate } = harness([first, second], async (id) =>
      id === first.id ? first : second,
    );
    await ready(panel);
    clearSessionAccess(first.id);
    const pendingAccess = Promise.withResolvers<never>();
    api.getSessionAccess.mockReturnValueOnce(pendingAccess.promise as never);

    const connecting = panel.actions.connect(first.id);
    await vi.waitFor(() => expect(api.getSessionAccess).toHaveBeenCalled());
    await emitSessions(panel, [{ ...first, state: "STOPPING" }, second]);
    pendingAccess.reject(new Error("tunnel is not reachable yet"));
    await connecting;

    expect(panel.state.error).toBe("tunnel is not reachable yet");
    expect(navigate).not.toHaveBeenCalled();
    panel.dispose();
  });

  it.each(["terminal snapshot", "seq change", "session stop"] as const)(
    "cancels deferred save-all selection at the %s boundary",
    async (boundary) => {
      window.history.replaceState(
        {},
        "",
        `/lite/lab/?session=${active.id}&seq=${active.seq}`,
      );
      const save = Promise.withResolvers<void>();
      const { panel, navigate, execute } = harness(
        [active, first],
        async () => first,
        active.id,
      );
      execute.mockImplementationOnce(() => save.promise);
      await ready(panel);
      await panel.actions.refreshJupyter(active.id);

      const selecting = panel.actions.connect(first.id);
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith("docmanager:save-all"),
      );
      if (boundary === "terminal snapshot") {
        await emitSessions(panel, [active, { ...first, state: "STOPPED" }]);
      } else if (boundary === "seq change") {
        await emitSessions(panel, [active, { ...first, seq: 2 }]);
      } else {
        const stopping = panel.actions.stop(first.id);
        await acceptDialog();
        await stopping;
      }
      save.resolve();
      await selecting;

      expect(navigate).not.toHaveBeenCalled();
      expect(loadSessionAccess(active.id, active.seq)).toBeDefined();
      panel.dispose();
    },
  );

  it("rechecks live seq after deferred save before navigating", async () => {
    window.history.replaceState(
      {},
      "",
      `/lite/lab/?session=${active.id}&seq=${active.seq}`,
    );
    const live = Promise.withResolvers<ISession>();
    let calls = 0;
    const { panel, api, navigate } = harness(
      [active, first],
      async () => {
        calls++;
        return calls === 1 ? first : live.promise;
      },
      active.id,
    );
    await ready(panel);
    await panel.actions.refreshJupyter(active.id);

    const selecting = panel.actions.connect(first.id);
    await vi.waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(2));
    await emitSessions(panel, [active, { ...first, seq: 2 }]);
    live.resolve(first);
    await selecting;

    expect(navigate).not.toHaveBeenCalled();
    expect(loadSessionAccess(active.id, active.seq)).toBeDefined();
    panel.dispose();
  });

  it("allows only the newest rapid selection to save and navigate", async () => {
    window.history.replaceState(
      {},
      "",
      "/lite/lab/?session=s-333333333333&seq=1",
    );
    const requests = new Map([
      [first.id, Promise.withResolvers<ISession>()],
      [second.id, Promise.withResolvers<ISession>()],
    ]);
    const { panel, navigate, execute } = harness(
      [first, second],
      (id) => requests.get(id)!.promise,
      active.id,
    );
    await ready(panel);

    void panel.actions.connect(first.id);
    void panel.actions.connect(second.id);
    requests.get(first.id)!.resolve(first);
    await requests.get(first.id)!.promise;
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    requests.get(second.id)!.resolve(second);
    await requests.get(second.id)!.promise;
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith("docmanager:save-all");
    expect(navigate).toHaveBeenCalledWith(`/selected/${second.id}`);
    expect(panel.state.connectingSessionId).toBeUndefined();
    panel.dispose();
  });
});

describe("current session pill", () => {
  it("marks only the session this page is attached to", () => {
    setActiveSessionId(first.id);
    const list = new SessionList();
    const other = { ...first, id: "s-999999999999" };
    setSessions(list, [first, other]);
    const cards = [
      ...list.node.querySelectorAll<HTMLElement>(".csSessionCard"),
    ];
    expect(cards[0].querySelector(".csCurrentPill")?.textContent).toBe(
      "Current",
    );
    expect(cards[0].classList).toContain("csSessionCardCurrent");
    expect(cards[0].getAttribute("aria-label")).toContain("current session");
    expect(cards[1].querySelector(".csCurrentPill")).toBeNull();
    expect(cards[1].classList).not.toContain("csSessionCardCurrent");
    setActiveSessionId(undefined);
  });
});

describe("session card contract", () => {
  it("shows host, resources, and state only, leaving the rest to the dialog", () => {
    const list = new SessionList();
    const gpu = {
      ...first,
      resources: { ...first.resources, cores: 8, memoryMb: 32768, gpuCount: 2 },
    };
    setSessions(list, [gpu]);
    const card = list.node.querySelector<HTMLElement>(".csSessionCard")!;
    expect(card.querySelector(".csSessionCardTitle")?.textContent).toBe(
      gpu.sshHost,
    );
    expect(
      [...card.querySelectorAll(".csResourceMeasure")].map((measure) => [
        measure.getAttribute("title"),
        measure.querySelector(".csResourceValue")?.textContent,
        !!measure.querySelector("svg"),
      ]),
    ).toEqual([
      ["8 CPU", "8", true],
      ["2 GPU", "2", true],
      ["32G memory", "32G", true],
      ["30m 0s of walltime left", "30m 0s left", true],
    ]);
    expect(card.querySelector(".csSessionCardMeta")?.textContent).toBe(
      "8·2·32G",
    );
    expect(card.querySelector(".csSessionState")?.textContent).toBe(gpu.state);
    expect(
      [...card.querySelectorAll(".csSessionCardIdentity > *")].map(
        (node) => node.textContent,
      ),
    ).toEqual([gpu.sshHost, gpu.account]);
    expect(card.textContent).not.toContain(gpu.rootFolder);
    expect(card.textContent).not.toContain("Jupyter:");
    expect(card.querySelector(".csSessionCardIcon svg")).not.toBeNull();
    expect(list.node.querySelector(".csSessionSectionRack")).not.toBeNull();
  });
});

describe("identity control", () => {
  it("offers sign in when signed out and hides the session cards behind a reason", () => {
    const list = new SessionList();
    const header = new CyberShuttleHeader();
    const signIn = vi.fn();
    header.signInRequested.connect(signIn);
    const state = { ...uiState({ sessions: [first] }), signedIn: false };
    list.setState(state);
    header.setState(state);
    expect(list.node.textContent).toContain(
      "Sign in to see your sessions and SSH hosts.",
    );
    expect(list.node.querySelector(".csSessionAddCard")).toBeNull();
    expect(list.node.querySelector(".csSessionCard")).toBeNull();
    expect(header.node.querySelector(".csAccountButton")).toBeNull();
    header.node.querySelector<HTMLButtonElement>(".csSignInButton")!.click();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("names the account and keeps sign out behind its menu", () => {
    const header = new CyberShuttleHeader();
    const signOut = vi.fn();
    header.signOutRequested.connect(signOut);
    header.setState({
      ...uiState({ sessions: [first] }),
      signedIn: true,
      account: "someone@gatech.edu",
    });
    const trigger =
      header.node.querySelector<HTMLButtonElement>(".csAccountButton")!;
    expect(trigger.textContent).toBe("someone@gatech.edu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(header.node.querySelector(".csAccountMenuItem")).toBeNull();

    trigger.click();
    const items = [
      ...header.node.querySelectorAll<HTMLButtonElement>(".csAccountMenuItem"),
    ];
    expect(items.map((each) => each.textContent)).toEqual([
      "SSH Keys",
      "Sign out",
    ]);
    expect(items.every((each) => each.querySelector("svg"))).toBe(true);
    const item = items[1];
    expect(
      header.node
        .querySelector(".csAccountButton")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    item.click();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
