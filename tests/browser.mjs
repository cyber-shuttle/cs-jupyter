import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
assert.ok(existsSync(join(dist, "lab", "index.html")), "dist is missing");

const runtimeId = "rt-111111111111";
const restartId = "rt-222222222222";
const createdId = "rt-333333333333";
const generation = "g-0123456789abcdef";
const linkspanOrigin = "https://31001.use.devtunnels.ms";
const directOrigin = "https://31002.use.devtunnels.ms";
const directBase = `/api/v1/runtimes/${createdId}/jupyter/`;
const accessToken = "browser-access-token";
// The header names who is signed in, from the id token's preferred_username.
const account = "user@example.edu";
const jupyterCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
let identityToken = "";
let staticOrigin = "";
let controlOrigin = "";
let popupCount = 0;
let tokenPollCount = 0;
let discoveryCount = 0;
let directTerminalSockets = 0;
const controlRequests = [];
const directRequests = [];
const linkspanRequests = [];
let activeLinkspanRuntime = runtimeId;
const jupyterStates = new Map([
  [runtimeId, "ready"],
  [createdId, "stopped"],
]);
const directWebSockets = [];
// cs-control stamps every log line: RuntimeLogLine is {stream, text, at},
// and the browser rejects a line carrying anything else or missing one.
const runtimeLog = [
  { stream: "stderr", text: "startup warning", at: "2026-01-01T00:00:02Z" },
];
const runtimes = [
  runtime(runtimeId, "projects/one"),
  runtime(restartId, "projects/restart", "FAILED"),
];

const staticServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (
    url.pathname === "/favicon.ico" ||
    url.pathname.endsWith("/favicon.ico")
  ) {
    response.writeHead(204);
    return response.end();
  }
  if (url.pathname === "/") {
    response.writeHead(303, { location: "/lite/lab/" });
    return response.end();
  }
  if (!url.pathname.startsWith("/lite/")) return missing(response);
  let relative = decodeURIComponent(url.pathname.slice(6));
  if (relative.endsWith("jupyter-lite.json")) {
    const config = JSON.parse(readFileSync(join(dist, relative), "utf8"));
    Object.assign(config["jupyter-config-data"], {
      cybershuttleControlApiUrl: `${controlOrigin}/api/v1`,
    });
    return json(response, config);
  }
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = normalize(join(dist, relative));
  if (
    !file.startsWith(`${dist}/`) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  )
    return missing(response);
  response.writeHead(200, { "content-type": contentType(file) });
  response.end(readFileSync(file));
});

const controlServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", controlOrigin);
  if (request.method === "OPTIONS") {
    cors(response);
    response.writeHead(204, {
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers":
        "Authorization, Content-Type, X-CyberShuttle-Identity",
    });
    return response.end();
  }
  controlRequests.push(`${request.method} ${url.pathname}`);
  cors(response);
  if (
    url.pathname === "/api/v1/oauth/device/start" &&
    request.method === "POST"
  ) {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    return json(response, {
      handle: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      userCode: "ABCD-EFGH",
      verificationUri: "https://verification.example.test/device",
      expiresInSeconds: 900,
      intervalSeconds: 1,
    });
  }
  if (
    url.pathname ===
      "/api/v1/oauth/device/poll/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" &&
    request.method === "POST"
  ) {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    tokenPollCount++;
    if (tokenPollCount === 1)
      return json(response, { status: "pending", intervalSeconds: 1 }, 202);
    const now = Math.floor(Date.now() / 1000);
    identityToken = jwt({
      aud: "native-client",
      iss: "https://login.microsoftonline.com/tenant/v2.0",
      iat: now,
      nbf: now,
      exp: now + 3600,
      oid: "owner",
      tid: "tenant",
      sub: "owner",
      preferred_username: "user@example.edu",
      name: "Test User",
      ver: "2.0",
    });
    return json(response, {
      status: "complete",
      expiresInSeconds: 3600,
      accessToken,
      idToken: identityToken,
    });
  }
  if (
    request.headers.authorization !== `Bearer ${accessToken}` ||
    request.headers["x-cybershuttle-identity"] !== identityToken
  )
    return json(
      response,
      { error: { code: "unauthorized", message: "unauthorized" } },
      401,
    );
  if (url.pathname === "/api/v1/ssh" && request.method === "GET")
    return json(response, {
      hosts: [
        {
          name: "cluster",
          hostname: "login.example.edu",
          user: "alice",
          port: 22,
          extraDirectives: [],
        },
      ],
    });
  // Discovery is a plain request. The first attempt demands an interactive
  // login; the second, after the auth socket succeeds, returns the resource.
  if (
    url.pathname === "/api/v1/ssh/cluster/slurm" &&
    request.method === "GET"
  ) {
    discoveryCount++;
    if (discoveryCount === 1) {
      return json(
        response,
        {
          error: {
            code: "ssh_authentication_required",
            message: "Interactive SSH authentication is required",
          },
        },
        409,
      );
    }
    return json(response, {
      host: "cluster",
      homeDir: "/home/alice",
      accounts: ["allocation"],
      partitions: [{ name: "debug", cpuCount: 16, memoryMb: 32768, gres: [] }],
    });
  }
  if (
    url.pathname === "/api/v1/runtimes/validate" &&
    request.method === "POST"
  ) {
    return readRequestJSON(request).then((body) => {
      assert.equal(body.rootFolder, "projects/browser-created");
      return json(response, {
        runtimeId: createdId,
        status: "PASSED",
        script: "#!/bin/bash\n#SBATCH --partition=debug\n",
        message: "Slurm accepted the script.",
      });
    });
  }
  if (url.pathname === "/api/v1/runtimes" && request.method === "POST") {
    return readRequestJSON(request).then((body) => {
      assert.equal(body.rootFolder, "projects/browser-created");
      assert.equal(body.linkspanSpec, undefined);
      let item = runtimes.find(({ id }) => id === createdId);
      if (!item) {
        item = runtime(createdId, body.rootFolder, "QUEUED");
        runtimes[0].state = "STOPPED";
        runtimes.push(item);
      }
      json(response, item, 201);
      setTimeout(() => {
        item.state = "READY";
        activeLinkspanRuntime = createdId;
      }, 25);
    });
  }
  if (url.pathname === "/api/v1/runtimes" && request.method === "GET")
    return json(response, {
      runtimes,
      refreshing: false,
      logs: [{ runtimeId: restartId, lines: runtimeLog }],
    });
  const accessMatch = /^\/api\/v1\/runtimes\/(rt-[a-f0-9]{12})\/access$/.exec(
    url.pathname,
  );
  if (accessMatch) {
    activeLinkspanRuntime = accessMatch[1];
    return json(response, {
      runtimeId: accessMatch[1],
      generation,
      expiresAt: "2030-01-01T00:00:00Z",
      linkspan: {
        uri: `${linkspanOrigin}/`,
        capability: jupyterCapability,
      },
    });
  }
  const runtimeMatch = /^\/api\/v1\/runtimes\/(rt-[a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (runtimeMatch)
    return json(
      response,
      runtimes.find(({ id }) => id === runtimeMatch[1]),
    );
  return missing(response);
});

const webSockets = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    const offered = [...protocols];
    assert.equal(offered[0], "cybershuttle.v1");
    assert.equal(offered.length, 3);
    assert.ok(offered[1].startsWith("bearer."));
    assert.equal(
      Buffer.from(offered[1].slice("bearer.".length), "base64url").toString(
        "utf8",
      ),
      accessToken,
    );
    assert.ok(offered[2].startsWith("identity."));
    assert.equal(
      Buffer.from(offered[2].slice("identity.".length), "base64url").toString(
        "utf8",
      ),
      identityToken,
    );
    return "cybershuttle.v1";
  },
});
controlServer.on("upgrade", (request, socket, head) => {
  assert.equal(request.headers.origin, staticOrigin);
  webSockets.handleUpgrade(request, socket, head, (webSocket) =>
    webSockets.emit("connection", webSocket, request),
  );
});
webSockets.on("connection", (socket, request) => {
  const path = new URL(request.url, controlOrigin).pathname;
  if (path.endsWith("/auth")) {
    setTimeout(() => socket.send(Buffer.from("Password: ")), 10);
    socket.on("message", () => socket.send(JSON.stringify({ type: "ready" })));
  }
});

await listen(staticServer);
await listen(controlServer);
staticOrigin = serverOrigin(staticServer);
controlOrigin = serverOrigin(controlServer);

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
});
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let page;
  context.on("page", (popup) => {
    if (page && popup !== page) popupCount++;
  });
  await installVerificationRoute(context);
  page = await context.newPage();
  const browserErrors = [];
  const browserMessages = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    browserMessages.push(message.text());
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await context.route(`${linkspanOrigin}/api/v1/jupyter`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type",
        },
      });
    }
    const entry = {
      method: request.method(),
      authorization: request.headers().authorization ?? "",
      body: request.method() === "POST" ? request.postDataJSON() : undefined,
      runtimeId: activeLinkspanRuntime,
    };
    linkspanRequests.push(entry);
    assert.equal(entry.authorization, `Bearer ${jupyterCapability}`);
    if (request.method() === "POST") {
      assert.deepEqual(entry.body, {
        root: "/home/alice/projects/browser-created",
        python: "/home/alice/.cybershuttle/jupyter-env/bin/python",
      });
      jupyterStates.set(activeLinkspanRuntime, "ready");
    } else if (request.method() === "DELETE") {
      jupyterStates.set(activeLinkspanRuntime, "stopped");
      return route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*" },
      });
    }
    const state = jupyterStates.get(activeLinkspanRuntime) ?? "stopped";
    return route.fulfill({
      status: request.method() === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        state === "ready"
          ? {
              state,
              uri: `${directOrigin}/`,
              publicBaseUrl: directBaseFor(activeLinkspanRuntime),
            }
          : { state },
      ),
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await context.route(`${directOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relative = url.pathname.slice(directBase.length);
    directRequests.push({
      method: request.method(),
      path: url.pathname,
      authorization: request.headers().authorization ?? "",
      cookie: request.headers().cookie ?? "",
    });
    let body = [];
    let status = 200;
    if (relative === "api/kernelspecs")
      body = {
        default: "python",
        kernelspecs: {
          python: {
            name: "python",
            resources: {},
            spec: {
              argv: ["python"],
              display_name: "Remote Python",
              language: "python",
            },
          },
        },
      };
    else if (relative === "api/contents" || relative === "api/contents/") {
      if (request.method() === "POST") status = 201;
      body =
        request.method() === "POST"
          ? fileModel("untitled.txt")
          : directoryModel();
    } else if (relative === "api/contents/untitled.txt")
      body = fileModel("untitled.txt");
    else if (relative === "api/contents/untitled.txt/checkpoints") {
      if (request.method() === "POST") status = 201;
      body =
        request.method() === "POST"
          ? { id: "checkpoint", last_modified: "2026-01-01T00:00:00Z" }
          : [];
    } else if (
      relative === "api/terminals" &&
      route.request().method() === "POST"
    )
      body = { name: "1", last_activity: "2026-01-01T00:00:00Z" };
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
      headers: {
        "access-control-allow-origin": "*",
      },
    });
  });
  await context.routeWebSocket("**/terminals/websocket/**", (socket) => {
    directTerminalSockets++;
    directWebSockets.push(socket.url());
    socket.send(JSON.stringify(["setup"]));
  });

  await page.goto(`${staticOrigin}/lite/lab/`);
  const panel = page.locator("#cybershuttle-runtime-panel");
  await panel.getByRole("heading", { name: "Runtimes", exact: true }).waitFor();
  assert.deepEqual(
    await panel.getByRole("heading").allTextContents(),
    ["Runtimes"],
    "the runtime panel exposes exactly its section heading",
  );
  // The product heading is the launcher's content header, not the panel's:
  // runtime-ui attaches it to launcher.contentHeader so it spans the launcher.
  assert.equal(
    await page
      .getByRole("heading", { name: "Cybershuttle", exact: true })
      .count(),
    1,
    "the product heading must appear once, in the launcher content header",
  );
  await page.getByRole("tab", { name: "Launcher", exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(popupCount, 0, "fresh load must not open an OAuth page");
  assert.deepEqual(
    controlRequests,
    [],
    "fresh load must not initialize HTTP or SSE",
  );
  assert.equal(await page.getByRole("button", { name: "Sign in" }).count(), 1);

  await page.getByRole("button", { name: "Sign in" }).click();
  const deviceDialog = page.getByRole("dialog", {
    name: "Sign in to Microsoft",
  });
  await deviceDialog.waitFor();
  assert.equal(
    popupCount,
    0,
    "device authorization must not open automatically",
  );
  assert.equal(await deviceDialog.getAttribute("aria-modal"), "true");
  await deviceDialog.getByText("ABCD-EFGH", { exact: true }).waitFor();
  const openSignIn = deviceDialog.getByRole("link", {
    name: "Open sign-in page",
  });
  assert.equal(
    await openSignIn.getAttribute("href"),
    "https://verification.example.test/device",
  );
  const verificationPage = context.waitForEvent("page");
  await openSignIn.click();
  await verificationPage;
  assert.equal(popupCount, 1, "only the explicit open action may open a page");
  await page
    .getByRole("button", { name: account })
    .waitFor({ timeout: 20_000 });
  await page.locator(`[data-runtime-action="${runtimeId}"]`).waitFor();
  // The name still has to say what the card is, even though it cannot be unique.
  assert.equal(
    await page
      .locator(`[data-runtime-action="${runtimeId}"]`)
      .getAttribute("aria-label"),
    "cluster, READY",
  );
  const browserState = await page.evaluate(() => ({
    href: window.location.href,
    localStorage: { ...window.localStorage },
    sessionStorage: { ...window.sessionStorage },
  }));
  // The refresh token and the device code are never the browser's to hold, so
  // they must appear nowhere it can reach.
  assert.doesNotMatch(
    JSON.stringify({ browserState, browserMessages }),
    /discarded-browser-refresh-token|private-device-code/,
    "the refresh token and device code must not enter storage, URLs, or logs",
  );
  // The access token is kept deliberately, for the reload that opening a runtime
  // performs -- but only in session storage, under one named key, and nowhere a
  // URL, a durable store or a log line would carry it.
  assert.doesNotMatch(
    JSON.stringify({
      href: browserState.href,
      localStorage: browserState.localStorage,
      browserMessages,
    }),
    /browser-access-token/,
    "the access token must not enter the URL, localStorage, or logs",
  );
  assert.deepEqual(
    Object.keys(browserState.sessionStorage),
    ["cybershuttle.oauth.v1"],
    "credentials live under exactly one session-storage key",
  );
  assert.ok(controlRequests.includes("GET /api/v1/runtimes"));

  assert.equal(
    await page
      .locator(
        ".jp-MainAreaWidget:has(.jp-Launcher):has(#cybershuttle-runtime-panel)",
      )
      .count(),
    1,
    "runtime panel must share the Launcher",
  );
  assert.deepEqual(
    await panel
      .locator(".csRuntimeCard")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-category")),
      ),
    ["Cybershuttle Runtimes", "Cybershuttle Runtimes"],
  );

  const runtimeSection = panel.locator(".csRuntimeSection");
  const otherSection = page
    .locator(".jp-Launcher-content > .jp-Launcher-section")
    .filter({
      has: page.getByRole("heading", { name: "Other", exact: true }),
    })
    .first();
  await otherSection.waitFor();
  const otherLayout = await launcherSectionLayout(otherSection);
  const runtimeLayout = await launcherSectionLayout(runtimeSection);
  for (const key of [
    "sectionLeft",
    "sectionRight",
    "headingLeft",
    "containerLeft",
    "containerRight",
    "firstCardLeft",
    "cardGap",
  ]) {
    assert.ok(
      Math.abs(runtimeLayout[key] - otherLayout[key]) <= 2,
      `${key} differs from Other: ${runtimeLayout[key]} vs ${otherLayout[key]}`,
    );
  }
  await page.setViewportSize({ width: 480, height: 720 });
  // At this width JupyterLab gives its whole main area ~150px and jp-Launcher
  // sets min-width: 120px, so our panel's box is narrower than any card can be
  // and no styling of ours makes it fit. What must hold is that we are not the
  // thing that breaks the page, and that we behave no worse than the launcher
  // section JupyterLab ships beside us.
  assert.deepEqual(
    await page.evaluate(() => {
      const doc = document.documentElement;
      const sections = Array.from(
        document.querySelectorAll(
          ".jp-Launcher-content > .jp-Launcher-section",
        ),
      );
      const overflows = (el) => el.scrollWidth > el.clientWidth;
      const ours = sections.filter((el) =>
        el.classList.contains("csRuntimeSection"),
      );
      const theirs = sections.filter(
        (el) => !el.classList.contains("csRuntimeSection"),
      );
      return [
        doc.scrollWidth <= doc.clientWidth,
        ours.some(overflows) ? theirs.some(overflows) : true,
      ];
    }),
    [true, true],
    "the page must not scroll sideways, and our section must overflow no sooner than JupyterLab's own",
  );
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.locator(`[data-runtime-action="${restartId}"]`).click();
  const runtimeDialog = page.locator(
    ".jp-Dialog-content:has(.csRuntimeDetail)",
  );
  await runtimeDialog.waitFor();
  assert.deepEqual(
    await runtimeDialog.evaluate((node) => [
      node.clientWidth >= 700,
      node.clientHeight >= 500,
      // Long content scrolls in the dialog body, not the page and not .csRoot.
      getComputedStyle(node.querySelector(".jp-Dialog-body")).overflowY,
    ]),
    [true, true, "auto"],
    "runtime modal must remain large and scrollable",
  );
  await runtimeDialog.getByText("startup warning", { exact: true }).waitFor();
  assert.equal(await runtimeDialog.locator(".csRuntimeLogLine").count(), 1);
  // A finished allocation cannot resume, so the detail offers to create another
  // like it and hands the wizard the finished runtime's configuration.
  await runtimeDialog.getByRole("button", { name: "Run again" }).click();
  await page.getByText("Add Runtime", { exact: true }).first().waitFor();
  assert.equal(
    await page.locator("input[name=rootFolder]").inputValue(),
    "projects/restart",
    "Run again must seed the finished runtime's root folder",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Add Runtime" }).click();
  // The host is a labelled select now, not a button.
  await page.getByLabel("SSH Host").selectOption("cluster");
  await page
    .locator(".csSshOperationTerminal .xterm-rows")
    .getByText("Password:", { exact: true })
    .waitFor();
  await page.locator(".csSshOperationTerminal .xterm-helper-textarea").focus();
  await page.keyboard.type("password");
  await page.keyboard.press("Control+M");
  const workspace = page.getByLabel("Workspace folder");
  await workspace.waitFor({ state: "visible" });
  assert.equal(
    discoveryCount,
    2,
    "discovery must resume once after interactive auth",
  );
  await workspace.fill("projects/browser-created");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("heading", { name: "Review Slurm job" }).waitFor();
  await page.getByText("Validation passed.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  const createdDetail = page.locator(
    ".jp-Dialog-content:has(.csRuntimeDetail)",
  );
  await createdDetail.getByText("READY", { exact: true }).waitFor({
    timeout: 20_000,
  });
  await createdDetail.getByText("stopped", { exact: true }).waitFor();
  await createdDetail
    .getByRole("button", { name: "Start Jupyter", exact: true })
    .click();
  await createdDetail.getByText("ready", { exact: true }).waitFor();
  assert.equal(
    linkspanRequests.filter(({ method }) => method === "POST").length,
    1,
    "creation flow must start Jupyter exactly once",
  );
  const controlBeforeCachedRestore = controlRequests.length;
  await createdDetail.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(
    new RegExp(`runtime=${createdId}.*generation=${generation}`),
    { timeout: 20_000 },
  );
  await page.waitForFunction(() => {
    const categories = [
      ...document.querySelectorAll(".jp-Launcher-sectionTitle"),
    ].map((node) => node.textContent);
    return ["Notebook", "Console", "Other", "Cybershuttle Runtimes"].every(
      (category) => categories.includes(category),
    );
  });
  assert.equal(
    await page
      .locator(
        ".jp-MainAreaWidget:has(.jp-Launcher):has(#cybershuttle-runtime-panel)",
      )
      .count(),
    1,
    "direct-runtime restore must retain one combined Launcher",
  );
  assert.deepEqual(
    controlRequests.slice(controlBeforeCachedRestore),
    [`GET /api/v1/runtimes/${createdId}`, `GET /api/v1/runtimes/${createdId}`],
    "Connect must validate then recheck live runtime, while cached restore must not issue access or bootstrap OAuth, list, or SSE",
  );
  const launcher = page.locator(".jp-Launcher");
  const contentsStart = directRequests.length;
  await launcher.getByText("Text File", { exact: true }).click();
  await waitForCondition(() =>
    directRequests
      .slice(contentsStart)
      .some(
        ({ method, path }) =>
          method === "POST" && path === `${directBase}api/contents`,
      ),
  );
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByText("New Launcher", { exact: true }).click();
  await page.locator(".jp-Launcher").waitFor();
  await page
    .locator('.jp-LauncherCard[title="Start a new terminal session"]')
    .click();
  await waitForCondition(() =>
    directRequests
      .slice(contentsStart)
      .some(
        ({ method, path }) =>
          method === "POST" && path === `${directBase}api/terminals`,
      ),
  );
  await page.waitForTimeout(100);

  const managerRequests = directRequests.slice(contentsStart);
  assert.ok(
    managerRequests.some(
      ({ method, path }) =>
        method === "POST" && path === `${directBase}api/contents`,
    ),
    "native Text File action did not use the direct ContentsManager",
  );
  assert.ok(
    managerRequests.some(
      ({ method, path }) =>
        method === "POST" && path === `${directBase}api/terminals`,
    ),
    "native Terminal card did not use the direct TerminalManager",
  );
  assert.ok(
    managerRequests
      .filter(
        ({ path }) =>
          path.includes("/api/contents") || path.endsWith("/api/terminals"),
      )
      .every(
        ({ authorization, cookie }) =>
          authorization === `Bearer ${jupyterCapability}` && cookie === "",
      ),
    "direct manager requests omitted the generation capability or sent cookies",
  );
  assert.deepEqual(directWebSockets, [
    `wss://31002.use.devtunnels.ms${directBase}terminals/websocket/1`,
  ]);
  assert.equal(directTerminalSockets, 1);

  await signInAgain(page);
  await page.locator(`[data-runtime-action="${createdId}"]`).click();
  let lifecycleDetail = page.locator(
    ".jp-Dialog-content:has(.csRuntimeDetail)",
  );
  await lifecycleDetail.getByText("ready", { exact: true }).waitFor();
  await lifecycleDetail
    .getByRole("button", { name: "Stop Jupyter", exact: true })
    .click();
  await lifecycleDetail.getByText("stopped", { exact: true }).waitFor();
  await page.waitForTimeout(150);
  assert.equal(
    await lifecycleDetail.getByText("stopped", { exact: true }).count(),
    1,
    "a delayed response must not resurrect stopped Jupyter state",
  );
  assert.equal(
    linkspanRequests.filter(({ method }) => method === "DELETE").length,
    1,
    "Jupyter stop must call Linkspan DELETE exactly once",
  );
  assert.equal(
    controlRequests.some(
      (entry) => entry === `POST /api/v1/runtimes/${createdId}/stop`,
    ),
    false,
    "Jupyter stop must not stop the allocation",
  );

  await page.reload();
  await page.getByRole("heading", { name: "Runtimes", exact: true }).waitFor();
  await signInAgain(page);
  await page.locator(`[data-runtime-action="${createdId}"]`).click();
  lifecycleDetail = page.locator(".jp-Dialog-content:has(.csRuntimeDetail)");
  await lifecycleDetail.getByText("stopped", { exact: true }).waitFor();
  await lifecycleDetail
    .getByRole("button", { name: "Start Jupyter", exact: true })
    .click();
  await lifecycleDetail.getByText("ready", { exact: true }).waitFor();
  const posts = linkspanRequests.filter(({ method }) => method === "POST");
  assert.equal(posts.length, 2, "same-tab reload must restart Jupyter once");
  assert.deepEqual(posts[1].body, {
    root: "/home/alice/projects/browser-created",
    python: "/home/alice/.cybershuttle/jupyter-env/bin/python",
  });

  assert.deepEqual(browserErrors, []);
  console.log(
    `validated device OAuth, validate/create/SSE, Linkspan Jupyter start-stop-reload-restart, direct managers, and SSH controls (${controlRequests.length} control requests)`,
  );
  await context.close();
} finally {
  webSockets.close();
  await browser.close();
  await close(staticServer);
  await close(controlServer);
}

async function signInAgain(page) {
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByText("New Launcher", { exact: true }).click();
  await page.getByRole("heading", { name: "Runtimes", exact: true }).waitFor();
  const signedIn = page.getByRole("button", { name: account, exact: true });
  if ((await signedIn.count()) > 0 && (await signedIn.isVisible())) return;
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await signIn.waitFor();
  await signIn.click();
  await signedIn.waitFor({ timeout: 20_000 });
}

async function launcherSectionLayout(section) {
  return section.evaluate((node) => {
    const heading = node.querySelector(".jp-Launcher-sectionTitle");
    const container = node.querySelector(".jp-Launcher-cardContainer");
    const cards = [...node.querySelectorAll(".jp-LauncherCard")];
    if (!(heading instanceof Element))
      throw new Error("missing section heading");
    if (!(container instanceof Element))
      throw new Error("missing card container");
    if (!(cards[0] instanceof Element)) throw new Error("missing first card");
    if (!(cards[1] instanceof Element)) throw new Error("missing second card");
    const sectionRect = node.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const firstRect = cards[0].getBoundingClientRect();
    const secondRect = cards[1].getBoundingClientRect();
    return {
      sectionLeft: sectionRect.left,
      sectionRight: sectionRect.right,
      headingLeft: headingRect.left,
      containerLeft: containerRect.left,
      containerRight: containerRect.right,
      firstCardLeft: firstRect.left,
      cardGap: secondRect.left - firstRect.right,
    };
  });
}

async function installVerificationRoute(context) {
  await context.route(
    "https://verification.example.test/device",
    async (route) => {
      assert.equal(route.request().method(), "GET");
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Microsoft device sign in</title>",
      });
    },
  );
}

function directoryModel() {
  return {
    name: "",
    path: "",
    type: "directory",
    writable: true,
    created: "2026-01-01T00:00:00Z",
    last_modified: "2026-01-01T00:00:00Z",
    mimetype: null,
    format: "json",
    content: [],
  };
}
function fileModel(path) {
  return {
    name: path,
    path,
    type: "file",
    writable: true,
    created: "2026-01-01T00:00:00Z",
    last_modified: "2026-01-01T00:00:00Z",
    mimetype: "text/plain",
    format: "text",
    content: "",
  };
}
async function waitForCondition(condition, timeout = 10_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function directBaseFor(id) {
  return `/api/v1/runtimes/${id}/jupyter/`;
}
function runtime(id, rootFolder, state = "READY") {
  const ready = state === "READY";
  return {
    id,
    generation,
    state,
    sshHost: "cluster",
    account: "allocation",
    partition: "debug",
    rootFolder,
    resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
    error: state === "FAILED" ? "Previous startup failed" : undefined,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
  };
}
function readRequestJSON(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
function cors(response) {
  response.setHeader("access-control-allow-origin", staticOrigin);
  response.setHeader("vary", "Origin");
}
function json(response, value, status = 200) {
  cors(response);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function missing(response) {
  response.writeHead(404);
  response.end("not found");
}
function listen(server) {
  return new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
}
function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}
function serverOrigin(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
function base64url(value) {
  return Buffer.from(value).toString("base64url");
}
function jwt(payload) {
  return `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(payload))}.signature`;
}
function contentType(path) {
  return (
    {
      ".css": "text/css",
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    }[extname(path)] ?? "application/octet-stream"
  );
}
