// The shared PlaneClient used for session lifecycle calls and for building
// Jupyter server connection settings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaneClient, createSessionServerSettings } from "../src/PlaneClient";
import { jsonResponse, validPlaneApiUrl } from "../src/Common";
import {
  installSessionCommandGuard,
  SessionController,
} from "../src/SessionController";
import { selectedSession, sessionLiteUrl } from "../src/session";
import { SshHosts } from "../src/SshHosts";
import { SshKeys } from "../src/SshKeys";
import {
  accessFixture,
  CLUSTER_ID,
  clusterFixture,
  credentialFixture,
  CREDENTIAL_ID,
  DEPLOYMENT_ID,
  deploymentFixture,
  fakeAuth,
  fakeCommandApp,
  planeFake,
  PROCESS_ID,
  processFixture,
  processId,
  sessionFixture,
  SLURM_CLUSTER_ID,
  slurmClusterFixture,
} from "./fakes";

const auth = fakeAuth("test-delegated-token");

const access = accessFixture(PROCESS_ID, {
  app: {
    uri: `http://localhost:3000/gateway/api/v1/processes/${PROCESS_ID}/proxy/24001/`,
    token: "A".repeat(43),
  },
});

const session = sessionFixture({
  account: "project-a",
  resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
});

beforeEach(() => {
  window.history.replaceState({}, "", "/gateway/lab");
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("shared CyberShuttle API client", () => {
  function makeClient(browserFetch: typeof globalThis.fetch) {
    return new PlaneClient(
      "http://localhost:3000/gateway/api/v1",
      auth,
      browserFetch,
    );
  }

  it("uses one exact API for discovery, host and session operations", async () => {
    const own = clusterFixture();
    const shared = clusterFixture({
      slurmClusterConfigId: processId(8),
      name: null,
      permission: "READ",
    });
    const { name: _name, ...deployment } = deploymentFixture();
    const replies: Record<string, unknown> = {
      "/slurm-cluster-configs/me": [own],
      "/slurm-cluster-configs/shared-with-me": [shared],
      "/slurm-deployments": [{ ...deployment, templateId: processId(9) }],
      "/application-templates": [
        { templateId: processId(9), templateName: "JupyterLab" },
      ],
      [`/slurm-cluster-configs/${CLUSTER_ID}/discover-allocations`]: {},
      "/slurm-clusters": [slurmClusterFixture()],
      "/ssh-credentials": [credentialFixture()],
      "/processes/me": [processFixture(session)],
      [`/processes/${PROCESS_ID}/access`]: access,
      [`/processes/${PROCESS_ID}/proxy/24000/api/v1/usage`]: { memBytes: 1024 },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const path = new URL(request.url).pathname.slice(
        "/gateway/api/v1".length,
      );
      return request.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse(replies[path] ?? processFixture(session));
    });
    const client = makeClient(fetch as any);
    await client.resumeSignIn();
    expect(await client.listConfigs()).toEqual([own, shared]);
    expect(await client.listDeployments()).toEqual([
      { ...deploymentFixture(), templateId: processId(9) },
    ]);
    await client.discoverSlurm(CLUSTER_ID);
    expect(await client.listSlurmClusters()).toEqual([slurmClusterFixture()]);
    expect(await client.listCredentials()).toEqual([credentialFixture()]);
    const host = {
      slurmClusterId: SLURM_CLUSTER_ID,
      loginUser: "me",
      workRoot: "/home/me",
      sshCredentialId: CREDENTIAL_ID,
    };
    await client.addComputeHost(host);
    await client.deleteComputeHost(CLUSTER_ID);
    const credential = {
      sshCredentialName: "laptop",
      publicKey: "ssh-ed25519 AAAA me@laptop",
      privateKey: "PRIVATE KEY TEXT",
    };
    await client.addCredential(credential);
    await client.deleteCredential(CREDENTIAL_ID);
    await client.listSessions();
    const request = {
      slurmClusterConfigId: CLUSTER_ID,
      deploymentId: DEPLOYMENT_ID,
      batchJobConfig: {
        allocation: "project-a",
        partition: "debug",
        cpus: 2,
        mem: "4096M",
        wallTimeMinutes: 30,
      },
    };
    await client.createSession(request);
    await client.startSession(PROCESS_ID);
    expect((await client.getSession(session.id)).id).toBe(PROCESS_ID);
    expect(await client.getSessionAccess(PROCESS_ID)).toEqual(access);
    expect(await client.getSessionUsage(session)).toEqual({ memBytes: 1024 });
    await client.stopSession(PROCESS_ID);
    const requests = fetch.mock.calls.map(([input]) => input as Request);
    const api = "http://localhost:3000/gateway/api/v1";
    expect(requests.map((item) => `${item.method} ${item.url}`)).toEqual([
      `GET ${api}/slurm-cluster-configs/me`,
      `GET ${api}/slurm-cluster-configs/shared-with-me`,
      `GET ${api}/slurm-deployments`,
      `GET ${api}/application-templates`,
      `POST ${api}/slurm-cluster-configs/${CLUSTER_ID}/discover-allocations`,
      `GET ${api}/slurm-clusters`,
      `GET ${api}/ssh-credentials`,
      `POST ${api}/slurm-cluster-configs`,
      `DELETE ${api}/slurm-cluster-configs/${CLUSTER_ID}`,
      `POST ${api}/ssh-credentials`,
      `DELETE ${api}/ssh-credentials/${CREDENTIAL_ID}`,
      `GET ${api}/processes/me`,
      `POST ${api}/processes`,
      `POST ${api}/processes/${PROCESS_ID}/launch`,
      `GET ${api}/processes/${PROCESS_ID}`,
      `GET ${api}/processes/${PROCESS_ID}/access`,
      `GET ${api}/processes/${PROCESS_ID}/proxy/24000/api/v1/usage`,
      `POST ${api}/processes/${PROCESS_ID}/stop`,
    ]);
    expect(await requests[7].clone().json()).toEqual(host);
    expect(await requests[9].clone().json()).toEqual(credential);
    expect(requests[16].headers.get("Authorization")).toBe(
      `token ${access.app.token}`,
    );
    expect(await requests[12].clone().json()).toEqual({
      processType: "BATCH_JOB",
      batchProcess: request,
    });
  });

  it("surfaces the server's message on a failed call", async () => {
    const client = makeClient(
      vi.fn(async () =>
        jsonResponse(
          { message: "Partition discovery failed" },
          { status: 502 },
        ),
      ) as any,
    );
    await expect(client.discoverSlurm(CLUSTER_ID)).rejects.toMatchObject({
      message: "Partition discovery failed",
      status: 502,
    });
  });

  it("refuses access before the job's link is up, or under a foreign proxy", async () => {
    const client = makeClient(
      vi.fn(async () =>
        jsonResponse({ message: "The job has no link" }, { status: 409 }),
      ) as any,
    );
    await expect(client.getSessionAccess(PROCESS_ID)).rejects.toMatchObject({
      status: 409,
    });
    const foreign = makeClient(
      vi.fn(async () =>
        jsonResponse({
          ...access,
          app: { ...access.app, uri: "https://other.example/proxy/" },
        }),
      ) as any,
    );
    await expect(foreign.getSessionAccess(PROCESS_ID)).rejects.toThrow(
      "outside its own API",
    );
  });

  it("accepts plain http on every loopback hostname a URL reports, and nowhere else", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "a.localhost"]) {
      const url = `http://${hostname}:8045/api/v1`;
      expect(validPlaneApiUrl(url)).toBe(url);
    }
    expect(() => validPlaneApiUrl("http://other.example/api/v1")).toThrow(
      "HTTPS or loopback HTTP",
    );
    expect(() => validPlaneApiUrl("/gateway/api/v1")).toThrow(
      "absolute CyberShuttle API URL",
    );
  });

  it("constructs token-authorized Jupyter HTTP and WebSocket settings", async () => {
    const settings = createSessionServerSettings(access);
    expect(settings.baseUrl).toBe(access.app.uri);
    expect(settings.wsUrl).toBe(access.app.uri.replace(/^http/, "ws"));
    expect(settings.token).toBe(access.app.token);
    expect(settings.appendToken).toBe(true);
  });

  it.each([401, 403])(
    "reloads once per run for fresh access after Jupyter HTTP %i",
    async (status) => {
      const reload = vi.fn();
      const refusing = () =>
        createSessionServerSettings(access, {
          fetch: vi.fn(async () => new Response(null, { status })) as any,
          reload,
        });
      const request = (settings: ReturnType<typeof refusing>) =>
        settings.fetch(new URL("api/status", settings.baseUrl).href);
      await request(refusing());
      const again = await request(refusing());
      expect(reload).toHaveBeenCalledOnce();
      expect((await again.json()).message).toContain("reopen the session");
    },
  );
});

describe("session command guard", () => {
  it("opens the chooser for notebooks, consoles, and terminals until selected", async () => {
    const { execute, app } = fakeCommandApp();
    const controller = new SessionController(
      app as any,
      {} as any,
      vi.fn(),
      vi.fn(),
    );
    installSessionCommandGuard(app as any, controller, "choose");
    await app.commands.execute("notebook:create-new");
    await app.commands.execute("console:create");
    await app.commands.execute("terminal:create-new");
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "choose",
      "choose",
      "choose",
    ]);
  });
});

describe("kernel spec logos", () => {
  it("drops resources an <img> could never fetch instead of rendering a broken icon", async () => {
    const body = {
      kernelspecs: {
        python3: {
          name: "python3",
          resources: {
            "logo-svg": "/kernelspecs/python3/logo-svg.svg",
            "logo-64x64": "/kernelspecs/python3/logo-64x64.png",
          },
        },
      },
    };
    const settings = createSessionServerSettings(access, {
      fetch: (async () => jsonResponse(body)) as unknown as typeof fetch,
    });
    const response = await settings.fetch(`${access.app.uri}api/kernelspecs`);
    const parsed = await response.json();
    expect(parsed.kernelspecs.python3.resources).toEqual({});
    expect(parsed.kernelspecs.python3.name).toBe("python3");
  });
});

describe("native Lite session routing", () => {
  const id = sessionFixture().id;

  it("selects only a matching session and workspace", () => {
    expect(selectedSession(`?session=${id}&workspace=${id}`)).toEqual({
      sessionId: id,
    });
    expect(
      selectedSession(`?session=${id}&workspace=${CLUSTER_ID}`),
    ).toBeUndefined();
    expect(selectedSession(`?session=s-abc&workspace=s-abc`)).toBeUndefined();
  });

  it("keeps session selection within the current Lite application URL", () => {
    expect(
      sessionLiteUrl(id, "folder/example.ipynb", {
        href: "http://localhost/lite/lab/index.html?old=value",
      }),
    ).toBe(
      `http://localhost/lite/lab/index.html?session=${id}&workspace=${id}&path=folder%2Fexample.ipynb`,
    );
  });
});

describe("compute host and credential dialogs", () => {
  const toggle = (widget: { node: HTMLElement }, action: string) =>
    widget.node
      .querySelector<HTMLButtonElement>(`[data-session-action="${action}"]`)!
      .click();
  const control = (widget: { node: HTMLElement }, name: string) =>
    widget.node.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  function fill(
    widget: { node: HTMLElement },
    values: Record<string, string>,
    event = "input",
  ): void {
    for (const [name, value] of Object.entries(values)) {
      control(widget, name).value = value;
      control(widget, name).dispatchEvent(new Event(event));
    }
  }

  it("lists owned and shared compute hosts and adds one", async () => {
    const api = planeFake({
      listConfigs: vi.fn(async () => [
        clusterFixture(),
        clusterFixture({
          slurmClusterConfigId: processId(8),
          permission: "READ",
        }),
      ]),
    });
    const widget = new SshHosts(api as any);
    await widget.refresh();
    const deletes = [
      ...widget.node.querySelectorAll<HTMLButtonElement>(".csDangerButton"),
    ];
    expect(widget.node.textContent).toContain("me · laptop · Owned");
    expect(widget.node.textContent).toContain("me · laptop · Shared");
    expect(deletes.map((each) => each.disabled)).toEqual([false, true]);
    toggle(widget, "add-compute-host-toggle");
    fill(widget, {
      computeHostLoginUser: " me ",
      computeHostWorkRoot: "/home/me",
    });
    widget.node.querySelector("form")!.requestSubmit();
    await vi.waitFor(() =>
      expect(api.addComputeHost).toHaveBeenCalledWith({
        slurmClusterId: SLURM_CLUSTER_ID,
        loginUser: "me",
        workRoot: "/home/me",
        sshCredentialId: CREDENTIAL_ID,
      }),
    );
  });

  it("uploads a keypair's private key file into the create request", async () => {
    const api = planeFake();
    const widget = new SshKeys(api as any);
    await widget.refresh();
    expect(widget.node.textContent).toContain("laptop");
    toggle(widget, "add-credential-toggle");
    fill(widget, {
      credentialName: "laptop",
      credentialPublicKey: "ssh-ed25519 AAAA me@laptop",
    });
    const file = control(widget, "credentialPrivateKey");
    Object.defineProperty(file, "files", {
      value: [new File(["PRIVATE KEY TEXT"], "id_ed25519")],
    });
    file.dispatchEvent(new Event("change"));
    widget.node.querySelector("form")!.requestSubmit();
    await vi.waitFor(() =>
      expect(api.addCredential).toHaveBeenCalledWith({
        sshCredentialName: "laptop",
        publicKey: "ssh-ed25519 AAAA me@laptop",
        privateKey: "PRIVATE KEY TEXT",
      }),
    );
    expect(widget.node.innerHTML).not.toContain("PRIVATE KEY TEXT");
  });

  it("saves a password credential without a keypair", async () => {
    const api = planeFake();
    const widget = new SshKeys(api as any);
    toggle(widget, "add-credential-toggle");
    fill(widget, { credentialKind: "password" }, "change");
    expect(control(widget, "credentialPublicKey")).toBeNull();
    fill(widget, { credentialName: "campus", credentialPassword: "pw" });
    widget.node.querySelector("form")!.requestSubmit();
    await vi.waitFor(() =>
      expect(api.addCredential).toHaveBeenLastCalledWith({
        sshCredentialName: "campus",
        password: "pw",
      }),
    );
  });

  it("saves a compute host with no credential as ask-at-login", async () => {
    const prompt = {
      ...credentialFixture(),
      sshCredentialId: processId(9),
      fullInteractive: true,
    };
    const api = planeFake({
      listCredentials: vi.fn(async () => [] as (typeof prompt)[]),
      addCredential: vi.fn(async () => prompt),
    });
    const widget = new SshHosts(api as any);
    await widget.refresh();
    for (const calls of [1, 1]) {
      toggle(widget, "add-compute-host-toggle");
      expect(control(widget, "computeHostCredential")!.value).toBe("");
      fill(widget, {
        computeHostLoginUser: "me",
        computeHostWorkRoot: "/home/me",
      });
      widget.node.querySelector("form")!.requestSubmit();
      await vi.waitFor(() =>
        expect(widget.node.querySelector("form")).toBeNull(),
      );
      expect(api.addComputeHost).toHaveBeenLastCalledWith(
        expect.objectContaining({ sshCredentialId: prompt.sshCredentialId }),
      );
      expect(api.addCredential).toHaveBeenCalledTimes(calls);
      api.listCredentials.mockResolvedValue([prompt]);
      await widget.refresh();
    }
    expect(api.addCredential).toHaveBeenCalledWith({
      sshCredentialName: "Ask at each login",
      fullInteractive: true,
    });
  });
});
