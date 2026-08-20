import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CyberShuttlePanel,
  type IRuntimeUiState,
} from "../src/CyberShuttlePanel";
import type { IRuntime } from "../src/Common";
import { RuntimeController } from "../src/RuntimeController";
import {
  cacheRuntimeAccess,
  clearRuntimeAccess,
  loadRuntimeAccess,
} from "../src/runtime-access";
import { RuntimeList } from "../src/RuntimeList";
import {
  pollPanel,
  runtimeFixture,
  runtimeListFixture,
  uiState,
} from "./fakes";

const first = runtimeFixture({
  id: "rt-111111111111",
  account: "project-a",
  rootFolder: "projects/one",
});
const second: IRuntime = {
  ...first,
  id: "rt-222222222222",
  rootFolder: "projects/two",
};
const active: IRuntime = {
  ...first,
  id: "rt-333333333333",
  rootFolder: "projects/active",
};
const hiddenLog = {
  epoch: "1".repeat(32),
  runtimeId: first.id,
  revision: 1,
  lines: [{ stream: "status" as const, text: "Preparing runtime" }],
};

function setRuntimes(
  list: RuntimeList,
  runtimes: IRuntime[],
  logs: IRuntimeUiState["logs"] = new Map(),
): void {
  list.setControllerState(
    uiState({
      runtimes,
      logs,
      jupyterReady: new Set(runtimes.map((runtime) => runtime.id)),
      signedIn: true,
    }),
  );
}

/** Reports a new runtime set on the next poll. */
async function emitRuntimes(
  panel: CyberShuttlePanel,
  runtimes: IRuntime[],
): Promise<void> {
  (panel as any)._api.listRuntimes.mockResolvedValue(
    runtimeListFixture(runtimes),
  );
  await pollPanel(panel);
}

function harness(
  runtimes: IRuntime[],
  getRuntime: (id: string) => Promise<IRuntime>,
) {
  const navigate = vi.fn();
  const execute = vi.fn(async () => undefined);
  const app = {
    commands: { execute, hasCommand: vi.fn(() => true) },
    shell: { currentWidget: null },
  };
  const api = {
    signIn: vi.fn(async () => undefined),
    listRuntimes: vi.fn(async () => runtimeListFixture(runtimes)),
    listSshHosts: vi.fn(async () => []),
    getRuntime: vi.fn(getRuntime),
    stopRuntime: vi.fn(async () => first),
    getRuntimeAccess: vi.fn(async (id: string) => ({
      runtimeId: id,
      generation: "g-0123456789abcdef",
      expiresAt: "2030-01-01T00:00:00Z",
      jupyter: {
        uri: "https://31002.use.devtunnels.ms/",
        token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    })),
  };
  sessionStorage.clear();
  for (const runtime of runtimes) {
    cacheRuntimeAccess({
      runtimeId: runtime.id,
      generation: runtime.generation,
      expiresAt: "2030-01-01T00:00:00Z",
      jupyter: {
        uri: "https://31002.use.devtunnels.ms/",
        token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
  }
  const controller = new RuntimeController(
    app as any,
    api as any,
    (id) => `/selected/${id}`,
    navigate,
  );
  const panel = new CyberShuttlePanel(api as any, controller);
  void panel.signIn();
  return { panel, api, navigate, execute };
}

function cacheReady(runtime: IRuntime): void {
  cacheRuntimeAccess({
    runtimeId: runtime.id,
    generation: runtime.generation,
    expiresAt: "2030-01-01T00:00:00Z",
    jupyter: {
      uri: "https://31002.use.devtunnels.ms/",
      token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
}

async function ready(panel: CyberShuttlePanel): Promise<void> {
  await vi.waitFor(() =>
    expect(panel.node.querySelectorAll(".csRuntimeCard")).toHaveLength(2),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const pathController = (): RuntimeController =>
  new RuntimeController(
    { commands: {}, shell: {} } as any,
    {} as any,
    (id) => `/selected/${id}`,
    undefined,
  );

describe("serialized runtime selection", () => {
  it("recognizes the current runtime only from the static Lite query", () => {
    window.history.replaceState(
      {},
      "",
      "/lite/lab/?runtime=rt-111111111111&generation=g-0123456789abcdef",
    );
    expect(pathController().currentRuntimeId).toBe("rt-111111111111");
  });

  it.each([
    "/gateway/team/notebooks/runtimes/rt-222222222222/jupyter/lab",
    "/api/v0/runtimes/rt-222222222222/jupyter/lab",
    "/api/v1/files/runtimes/rt-222222222222/jupyter/lab",
    "/r/rt-222222222222/jupyter/lab",
    "/gateway/myruntimes/rt-222222222222/jupyter/lab",
  ])(
    "rejects a runtime-looking path outside the exact control API: %s",
    (path) => {
      window.history.replaceState({}, "", path);
      expect(pathController().currentRuntimeId).toBeUndefined();
    },
  );

  it("renders native runtime cards and opens their live detail modal", async () => {
    const { panel } = harness(
      [first, { ...second, state: "FAILED" }],
      async (id) => (id === first.id ? first : second),
    );
    const openRuntime = vi
      .spyOn(panel, "openRuntime")
      .mockResolvedValue(undefined);
    await ready(panel);
    const cards =
      panel.node.querySelectorAll<HTMLButtonElement>(".jp-LauncherCard");
    expect([
      cards.length,
      [...cards].slice(0, 2).every((card) => card.tagName === "BUTTON"),
      cards[0].ariaLabel?.includes("projects/one, READY"),
      cards[0].textContent?.includes("delta · 1 CPU · 1024 MB"),
      cards[1].ariaLabel?.includes("FAILED"),
      cards[0].querySelector(".csRuntimeState-ready")?.textContent,
      cards[2].classList.contains("csRuntimeAddCard"),
      cards[2].textContent?.includes("Add Runtime"),
    ]).toEqual([3, true, true, true, true, "READY", true, true]);
    expect(
      [...panel.node.querySelectorAll("h2")].map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Cybershuttle", "Cybershuttle Runtimes"]);
    expect(
      panel.node.querySelector(
        ".jp-Launcher-body > .jp-Launcher-content > .jp-Launcher-section > .jp-Launcher-cardContainer",
      ),
    ).not.toBeNull();
    cards[0].click();
    expect(openRuntime).toHaveBeenCalledWith(first.id);
    panel.dispose();
  });

  it("emits runtime, Add Runtime, and SSH Hosts card actions once", () => {
    const list = new RuntimeList();
    const runtimeRequested = vi.fn();
    const createRequested = vi.fn();
    const sshHostsRequested = vi.fn();
    list.runtimeRequested.connect((_sender, id) => runtimeRequested(id));
    list.createRequested.connect(createRequested);
    list.sshHostsRequested.connect(sshHostsRequested);
    list.setCanCreate(true);
    setRuntimes(list, [first], new Map([[first.id, hiddenLog]]));
    expect(list.node.textContent).not.toContain("Preparing runtime");
    document.body.appendChild(list.node);
    list.node.querySelector<HTMLButtonElement>(".csRuntimeCard")!.focus();
    setRuntimes(list, [{ ...first }]);
    expect(document.activeElement?.getAttribute("aria-label")).toContain(
      "projects/one",
    );

    list.node.querySelector<HTMLButtonElement>(".csRuntimeCard")!.click();
    list.node.querySelector<HTMLButtonElement>(".csRuntimeAddCard")!.click();
    [...list.node.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "SSH Hosts")!
      .click();

    expect([
      runtimeRequested.mock.calls,
      createRequested.mock.calls.length,
      sshHostsRequested.mock.calls.length,
    ]).toEqual([[[first.id]], 1, 1]);
    list.dispose();
  });

  it("does not navigate when the panel closes before selection resolves", async () => {
    window.history.replaceState({}, "", "/gateway/lab");
    const pending = Promise.withResolvers<IRuntime>();
    const { panel, navigate } = harness([first, second], () => pending.promise);
    await ready(panel);

    void panel.connect(first.id);
    expect(panel.state.connectingRuntimeId).toBe(first.id);

    panel.dispose();
    pending.resolve(first);
    await pending.promise;
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["target access", "target select", "save-all"] as const)(
    "retains the active session when %s fails",
    async (failure) => {
      window.history.replaceState(
        {},
        "",
        `/lite/lab/?runtime=${active.id}&generation=${active.generation}`,
      );
      const { panel, api, navigate, execute } = harness(
        [first, second],
        async (id) => (id === first.id ? first : second),
      );
      cacheReady(active);
      await ready(panel);
      if (failure === "target access") {
        clearRuntimeAccess(first.id);
        api.getRuntimeAccess.mockRejectedValueOnce(
          new Error("target access failed"),
        );
      } else if (failure === "target select") {
        api.getRuntime.mockRejectedValueOnce(new Error("target select failed"));
      } else {
        execute.mockRejectedValueOnce(new Error("save failed"));
      }

      await panel.connect(first.id);

      expect(loadRuntimeAccess(active.id, active.generation)).toBeDefined();
      expect(navigate).not.toHaveBeenCalled();
      panel.dispose();
    },
  );

  it.each([
    "terminal snapshot",
    "generation change",
    "allocation stop",
  ] as const)(
    "cancels deferred save-all selection at the %s boundary",
    async (boundary) => {
      window.history.replaceState(
        {},
        "",
        `/lite/lab/?runtime=${active.id}&generation=${active.generation}`,
      );
      const save = Promise.withResolvers<void>();
      const { panel, navigate, execute } = harness(
        [active, first],
        async () => first,
      );
      execute.mockImplementationOnce(() => save.promise);
      await ready(panel);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                state: "ready",
                uri: "https://31002.use.devtunnels.ms/",
                publicBaseUrl: `/api/v1/runtimes/${active.id}/jupyter/`,
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );
      await panel.refreshJupyter(active.id);

      const selecting = panel.connect(first.id);
      await vi.waitFor(() =>
        expect(execute).toHaveBeenCalledWith("docmanager:save-all"),
      );
      if (boundary === "terminal snapshot") {
        await emitRuntimes(panel, [active, { ...first, state: "STOPPED" }]);
      } else if (boundary === "generation change") {
        await emitRuntimes(panel, [
          active,
          { ...first, generation: "g-fedcba9876543210" },
        ]);
      } else {
        await panel.stop(first.id);
      }
      save.resolve();
      await selecting;

      expect(navigate).not.toHaveBeenCalled();
      expect(loadRuntimeAccess(active.id, active.generation)).toBeDefined();
      panel.dispose();
    },
  );

  it("rechecks live generation after deferred save before navigating", async () => {
    window.history.replaceState(
      {},
      "",
      `/lite/lab/?runtime=${active.id}&generation=${active.generation}`,
    );
    const live = Promise.withResolvers<IRuntime>();
    let calls = 0;
    const { panel, api, navigate } = harness([active, first], async () => {
      calls++;
      return calls === 1 ? first : live.promise;
    });
    await ready(panel);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: "ready",
              uri: "https://31002.use.devtunnels.ms/",
              publicBaseUrl: `/api/v1/runtimes/${active.id}/jupyter/`,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await panel.refreshJupyter(active.id);

    const selecting = panel.connect(first.id);
    await vi.waitFor(() => expect(api.getRuntime).toHaveBeenCalledTimes(2));
    await emitRuntimes(panel, [
      active,
      { ...first, generation: "g-fedcba9876543210" },
    ]);
    live.resolve(first);
    await selecting;

    expect(navigate).not.toHaveBeenCalled();
    expect(loadRuntimeAccess(active.id, active.generation)).toBeDefined();
    panel.dispose();
  });

  it("allows only the newest rapid selection to save and navigate", async () => {
    window.history.replaceState(
      {},
      "",
      "/lite/lab/?runtime=rt-333333333333&generation=g-0123456789abcdef",
    );
    const requests = new Map([
      [first.id, Promise.withResolvers<IRuntime>()],
      [second.id, Promise.withResolvers<IRuntime>()],
    ]);
    const { panel, navigate, execute } = harness(
      [first, second],
      (id) => requests.get(id)!.promise,
    );
    await ready(panel);

    void panel.connect(first.id);
    void panel.connect(second.id);
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
    expect(panel.state.connectingRuntimeId).toBeUndefined();
    panel.dispose();
  });
});

describe("current session pill", () => {
  it("marks only the runtime this page is attached to", () => {
    const list = new RuntimeList();
    const other = { ...first, id: "rt-999999999999" };
    list.setCurrentRuntimeId(first.id);
    setRuntimes(list, [first, other]);
    const cards = [
      ...list.node.querySelectorAll<HTMLElement>(".csRuntimeCard"),
    ];
    expect(cards[0].querySelector(".csCurrentPill")?.textContent).toBe(
      "Current",
    );
    expect(cards[0].classList).toContain("csRuntimeCardCurrent");
    expect(cards[0].getAttribute("aria-label")).toContain("current session");
    expect(cards[1].querySelector(".csCurrentPill")).toBeNull();
    expect(cards[1].classList).not.toContain("csRuntimeCardCurrent");
  });
});
