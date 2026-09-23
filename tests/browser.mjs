// Playwright end-to-end run against dist, driving real Chromium against a
// fake cs-plane, a fake OAuth issuer, and a fake Jupyter server. It exercises
// PKCE sign-in, the Dev Tunnels device-link flow gating session create, and
// the session lifecycle through the real built extension. Two console
// messages are expected noise: the on-purpose 409 tunnel-link handshake and
// an xterm teardown race.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
assert.ok(existsSync(join(dist, "lab", "index.html")), "dist is missing");

const sessionId = "s-111111111111";
const restartId = "s-222222222222";
const createdId = "s-333333333333";
const seq = 1;
const directOrigin = "https://31002.use.devtunnels.ms";
const account = "user@example.edu";
const jupyterToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const tunnelHandle = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const issuerOrigin = "https://issuer.example.test";
let idToken = "";
let verifierUsed = "";
let capturedAuthorize;
let staticOrigin = "";
let controlOrigin = "";
let popupCount = 0;
let tunnelLinked = false;
let tunnelPollCount = 0;
let discoveryCount = 0;
const controlRequests = [];
const directRequests = [];
const directWebSockets = [];
const sessionLog = [
  { stream: "stderr", text: "startup warning", at: "2026-01-01T00:00:02Z" },
];
const restartLog = [
  { stream: "stderr", text: "job failed", at: "2026-01-01T00:00:03Z" },
];
const sessions = [
  session(sessionId, "projects/one"),
  session(restartId, "projects/restart", "FAILED"),
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
        "Authorization, Content-Type, If-None-Match",
    });
    return response.end();
  }
  controlRequests.push(`${request.method} ${url.pathname}`);
  cors(response);
  if (url.pathname === "/api/v1/oauth/config" && request.method === "GET") {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    return json(response, {
      issuer: issuerOrigin,
      authorizationEndpoint: `${issuerOrigin}/authorize`,
      clientId: "cybershuttle-jupyter",
      scope: "openid email profile",
    });
  }
  if (url.pathname === "/api/v1/oauth/exchange" && request.method === "POST") {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    return readRequestJSON(request).then((body) => {
      assert.equal(body.code, "browser-code");
      assert.equal(typeof body.codeVerifier, "string");
      assert.equal(
        createHash("sha256").update(body.codeVerifier).digest("base64url"),
        capturedAuthorize?.codeChallenge,
        "the code verifier must hash to the challenge the authorize request carried",
      );
      assert.ok(
        body.redirectUri.startsWith(staticOrigin),
        "the redirect URI must stay on the extension's own origin",
      );
      verifierUsed = body.codeVerifier;
      const now = Math.floor(Date.now() / 1000);
      idToken = jwt({
        iss: issuerOrigin,
        aud: "cybershuttle-jupyter",
        sub: "owner",
        email: account,
        iat: now,
        exp: now + 3600,
      });
      return json(response, { idToken, expiresInSeconds: 900 });
    });
  }
  if (request.headers.authorization !== `Bearer ${idToken}`)
    return json(
      response,
      { error: { code: "unauthorized", message: "unauthorized" } },
      401,
      { "www-authenticate": "Bearer" },
    );
  if (url.pathname === "/api/v1/tunnel" && request.method === "GET")
    return json(response, tunnelLinkStatus());
  if (
    url.pathname === "/api/v1/tunnel/authorizations" &&
    request.method === "POST"
  )
    return readRequestJSON(request).then((body) => {
      assert.equal(body.provider, "github");
      return json(response, {
        handle: tunnelHandle,
        userCode: "ABCD-EFGH",
        verificationUri: "https://verification.example.test/device",
        expiresInSeconds: 900,
        intervalSeconds: 1,
      });
    });
  if (
    url.pathname === `/api/v1/tunnel/authorizations/${tunnelHandle}/poll` &&
    request.method === "POST"
  ) {
    tunnelPollCount++;
    if (tunnelPollCount === 1)
      return json(response, { status: "pending", intervalSeconds: 1 });
    tunnelLinked = true;
    return json(response, tunnelLinkStatus());
  }
  if (url.pathname === "/api/v1/hosts" && request.method === "GET")
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
  if (
    url.pathname === "/api/v1/hosts/cluster/slurm" &&
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
      accounts: ["project-a"],
      partitions: [{ name: "debug", cpuCount: 16, memoryMb: 32768, gres: [] }],
      homeDir: "/home/browser",
    });
  }
  if (
    url.pathname === "/api/v1/sessions/validate" &&
    request.method === "POST"
  ) {
    return readRequestJSON(request).then((body) => {
      assert.equal(body.rootFolder, "projects/browser-created");
      return json(response, {
        sessionId: "s-012345abcdef",
        status: "PASSED",
        script: "#!/bin/bash\n#SBATCH --partition=debug\n",
        message: "Slurm accepted the script.",
      });
    });
  }
  if (url.pathname === "/api/v1/sessions" && request.method === "POST") {
    return readRequestJSON(request).then((body) => {
      assert.equal(body.rootFolder, "projects/browser-created");
      let item = sessions.find(({ id }) => id === createdId);
      if (!item) {
        item = { ...session(createdId, body.rootFolder, "STOPPED"), seq: 0 };
        sessions.push(item);
      }
      json(response, item, 201, {
        location: `/api/v1/sessions/${item.id}`,
      });
    });
  }
  if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
    const body = {
      sessions,
      logs: [
        { sessionId, lines: sessionLog },
        { sessionId: restartId, lines: restartLog },
      ],
    };
    const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
    if (request.headers["if-none-match"] === etag) {
      cors(response);
      response.writeHead(304, { etag });
      return response.end();
    }
    return json(response, body, 200, { etag });
  }
  if (url.pathname === "/api/v1/telemetry" && request.method === "GET")
    return json(response, { runs: [] });
  const metricsMatch = /^\/api\/v1\/sessions\/(s-[a-f0-9]{12})\/metrics$/.exec(
    url.pathname,
  );
  if (metricsMatch)
    return json(response, { sessionId: metricsMatch[1], samples: [] });
  const accessMatch = /^\/api\/v1\/sessions\/(s-[a-f0-9]{12})\/access$/.exec(
    url.pathname,
  );
  if (accessMatch) {
    return json(response, {
      sessionId: accessMatch[1],
      seq,
      expiresAt: "2030-01-01T00:00:00Z",
      jupyter: { uri: `${directOrigin}/`, token: jupyterToken },
    });
  }
  const startMatch = /^\/api\/v1\/sessions\/(s-[a-f0-9]{12})\/start$/.exec(
    url.pathname,
  );
  if (startMatch && request.method === "POST") {
    const item = sessions.find(({ id }) => id === startMatch[1]);
    if (!tunnelLinked)
      return json(
        response,
        {
          error: {
            code: "tunnel_link_required",
            message: "Link your Dev Tunnels account to start a session.",
          },
        },
        409,
      );
    item.state = "QUEUED";
    item.seq += 1;
    item.error = undefined;
    if (item.id === createdId)
      setTimeout(() => {
        item.state = "READY";
      }, 25);
    return json(response, item);
  }
  const stopMatch = /^\/api\/v1\/sessions\/(s-[a-f0-9]{12})\/stop$/.exec(
    url.pathname,
  );
  if (stopMatch && request.method === "POST") {
    const item = sessions.find(({ id }) => id === stopMatch[1]);
    item.state = "STOPPING";
    return json(response, item);
  }
  const sessionMatch = /^\/api\/v1\/sessions\/(s-[a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (sessionMatch && request.method === "DELETE") {
    const item = sessions.find(({ id }) => id === sessionMatch[1]);
    if (item && item.state !== "STOPPED" && item.state !== "FAILED")
      return json(
        response,
        {
          error: {
            code: "session_not_stopped",
            message: "stop the session before deleting it",
          },
        },
        409,
      );
    const index = sessions.findIndex(({ id }) => id === sessionMatch[1]);
    if (index !== -1) sessions.splice(index, 1);
    cors(response);
    response.writeHead(204);
    return response.end();
  }
  if (sessionMatch)
    return json(
      response,
      sessions.find(({ id }) => id === sessionMatch[1]),
    );
  return json(
    response,
    { error: { code: "not_found", message: "Route not found." } },
    404,
  );
});

const webSockets = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    const offered = [...protocols];
    assert.equal(offered.length, 2);
    assert.equal(offered[0], "cybershuttle.v1");
    assert.ok(offered[1].startsWith("bearer."));
    assert.equal(
      Buffer.from(offered[1].slice("bearer.".length), "base64url").toString(
        "utf8",
      ),
      idToken,
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
  assert.equal(path, "/api/v1/hosts/cluster/ssh");
  setTimeout(() => socket.send(Buffer.from("Password: ")), 10);
  socket.on("message", () => socket.send(JSON.stringify({ type: "ready" })));
});

await listen(staticServer);
await listen(controlServer);
staticOrigin = serverOrigin(staticServer);
controlOrigin = serverOrigin(controlServer);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let page;
  context.on("page", (popup) => {
    if (page && popup !== page) popupCount++;
  });
  await installVerificationRoute(context);
  await installIssuerRoute(context);
  page = await context.newPage();
  const browserErrors = [];
  const browserMessages = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    browserMessages.push(message.text());
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await context.route(`${directOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relative = url.pathname.slice(1);
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
    directWebSockets.push(socket.url());
    socket.send(JSON.stringify(["setup"]));
  });

  await page.goto(
    `${staticOrigin}/lite/lab/index.html?session=${sessionId}&workspace=${sessionId}`,
  );
  const panel = page.locator("#cybershuttle-session-panel");
  await panel.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  assert.deepEqual(
    await panel.getByRole("heading").allTextContents(),
    ["Sessions"],
    "the session panel exposes exactly its section heading",
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "CyberShuttle", exact: true })
      .count(),
    1,
    "the product heading must appear once, in the launcher content header",
  );
  await page.getByRole("tab", { name: "Launcher", exact: true }).waitFor();
  const signInPrompt = page
    .locator(".jp-Dialog")
    .filter({ hasText: "Welcome to CyberShuttle Jupyter" });
  await signInPrompt.waitFor();
  assert.equal(page.url(), `${staticOrigin}/lite/lab/index.html`);
  assert.equal(await signInPrompt.locator(".csSignInLogo").count(), 1);
  assert.ok((await signInPrompt.textContent()).includes("remote HPC sessions"));
  assert.equal(popupCount, 0, "fresh load must not open an OAuth page");
  assert.deepEqual(
    controlRequests,
    [],
    "fresh load must not initialize HTTP or polling",
  );

  await signInPrompt.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("button", { name: account })
    .waitFor({ timeout: 20_000 });
  assert.equal(
    popupCount,
    0,
    "sign-in navigates the top window to the issuer and back; it must not open a popup",
  );
  const afterSignInUrl = new URL(page.url());
  assert.equal(
    afterSignInUrl.searchParams.has("code"),
    false,
    "the callback query must be gone once the exchange completes",
  );
  assert.equal(afterSignInUrl.searchParams.has("state"), false);

  await page.locator(`[data-session-action="${sessionId}"]`).waitFor();
  assert.equal(
    await page
      .locator(`[data-session-action="${sessionId}"]`)
      .getAttribute("aria-label"),
    "cluster, READY",
  );
  const browserState = await page.evaluate(() => ({
    href: window.location.href,
    localStorage: { ...window.localStorage },
    sessionStorage: { ...window.sessionStorage },
  }));
  const leakSurface = JSON.stringify({
    href: browserState.href,
    localStorage: browserState.localStorage,
    browserMessages,
  });
  assert.equal(
    leakSurface.includes(idToken),
    false,
    "the ID token must not enter the URL, localStorage, or logs",
  );
  assert.equal(
    leakSurface.includes(verifierUsed),
    false,
    "the PKCE code verifier must not enter the URL, localStorage, or logs",
  );
  assert.deepEqual(
    Object.keys(browserState.sessionStorage)
      .map((key) => key.replace(/\.s-[a-f0-9]{12}$/, ".<session>"))
      .sort(),
    ["cybershuttle.oauth.v1", "cybershuttle.session-access.v1.<session>"],
    "session storage holds only the credentials and the cached session access",
  );
  assert.ok(controlRequests.includes("GET /api/v1/sessions"));

  assert.equal(
    await page
      .locator(
        ".jp-MainAreaWidget:has(.jp-Launcher):has(#cybershuttle-session-panel)",
      )
      .count(),
    1,
    "session panel must share the Launcher",
  );
  assert.deepEqual(
    await panel
      .locator(".csSessionCard")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-category")),
      ),
    ["CyberShuttle Sessions", "CyberShuttle Sessions"],
  );

  const sessionSection = panel.locator(".csSessionSection");
  const otherSection = page
    .locator(".jp-Launcher-content > .jp-Launcher-section")
    .filter({
      has: page.getByRole("heading", { name: "Other", exact: true }),
    })
    .first();
  await otherSection.waitFor();
  const otherLayout = await launcherSectionLayout(otherSection);
  const sessionLayout = await launcherSectionLayout(sessionSection);
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
      Math.abs(sessionLayout[key] - otherLayout[key]) <= 2,
      `${key} differs from Other: ${sessionLayout[key]} vs ${otherLayout[key]}`,
    );
  }
  await page.setViewportSize({ width: 480, height: 720 });
  assert.deepEqual(
    await page.evaluate(() => {
      const doc = document.documentElement;
      const sections = Array.from(
        document.querySelectorAll(".jp-Launcher-section"),
      );
      const overflows = (el) => el.scrollWidth > el.clientWidth;
      const ours = sections.filter((el) =>
        el.classList.contains("csSessionSection"),
      );
      const theirs = sections.filter(
        (el) => !el.classList.contains("csSessionSection"),
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

  await page.locator(`[data-session-action="${restartId}"]`).click();
  const sessionDialog = page.locator(
    ".jp-Dialog-content:has(.csSessionDetail)",
  );
  await sessionDialog.waitFor();
  assert.deepEqual(
    await sessionDialog
      .locator(".csSessionDetailActions button")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          return [button.textContent, style.color, style.borderStyle];
        }),
      ),
    [
      ["Run again", "rgb(255, 255, 255)", "solid"],
      ["Delete", "rgb(211, 47, 47)", "solid"],
    ],
    "Jupyter dialog styling must not override session action variants",
  );
  assert.deepEqual(
    await sessionDialog.evaluate((node) => [
      node.clientWidth >= 700,
      getComputedStyle(node.querySelector(".jp-Dialog-body")).overflowY,
    ]),
    [true, "auto"],
    "session modal must remain wide and scrollable",
  );
  assert.equal(
    await sessionDialog.locator(".csSessionLogLine").count(),
    0,
    "a finished session must not carry a log on its card",
  );
  assert.equal(
    await sessionDialog.locator(".csRunReport").count(),
    0,
    "a finished session's report belongs to the run history",
  );
  const cardsBeforeRunAgain = await page.locator(".csSessionCard").count();
  await sessionDialog.getByRole("button", { name: "Run again" }).click();
  const linkGitHub = page.getByRole("button", { name: "Link GitHub" });
  await linkGitHub.waitFor();
  await linkGitHub.click();
  const deviceDialog = page.getByRole("dialog", { name: "Sign in to GitHub" });
  await deviceDialog.waitFor();
  assert.equal(
    popupCount,
    0,
    "device authorization must not open automatically",
  );
  assert.notEqual(await deviceDialog.getAttribute("open"), null);
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
  const tunnelDialog = page.locator(".jp-Dialog-content", {
    has: page.getByRole("button", { name: "Unlink" }),
  });
  await tunnelDialog.waitFor();
  await tunnelDialog.locator(".jp-Dialog-close-button").click();
  await page.locator(`[data-session-action="${restartId}"]`).click();
  await sessionDialog.getByText("QUEUED", { exact: true }).waitFor();
  assert.ok(
    controlRequests.includes(`POST /api/v1/sessions/${restartId}/start`),
    "Run again must run the finished session rather than create another",
  );
  assert.equal(
    await page.locator(".csSessionCard").count(),
    cardsBeforeRunAgain,
    "Run again must not add a card",
  );
  await sessionDialog.locator(".jp-Dialog-close-button").click();

  await page.getByRole("button", { name: "Add Session" }).click();
  const styledControlDifferences = await page
    .locator(".csInput.jp-mod-styled, .csSelect.jp-mod-styled")
    .evaluateAll((controls) =>
      controls.flatMap((control) => {
        const clone = control.cloneNode(true);
        clone.classList.remove("jp-mod-styled");
        clone.style.position = "fixed";
        clone.style.visibility = "hidden";
        document.body.appendChild(clone);
        const styled = getComputedStyle(control);
        const plain = getComputedStyle(clone);
        const properties = [
          "padding",
          "border",
          "color",
          "font",
          "lineHeight",
          "letterSpacing",
          "appearance",
        ];
        const differences = properties
          .filter((property) => styled[property] !== plain[property])
          .map((property) => [
            control.getAttribute("name"),
            property,
            styled[property],
            plain[property],
          ]);
        clone.remove();
        return differences;
      }),
    );
  assert.deepEqual(
    styledControlDifferences,
    [],
    "Jupyter dialog styling must not alter CyberShuttle inputs or selects",
  );
  assert.equal(
    await page
      .locator(".jp-select-wrapper:has(> .csSelect)")
      .first()
      .evaluate((wrapper) => getComputedStyle(wrapper).display),
    "contents",
    "Jupyter's select wrapper must not alter the form layout",
  );
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
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("heading", { name: "Review Slurm job" }).waitFor();
  await page.getByText("Validation passed.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Submit", exact: true }).click();

  const createdDetail = page.locator(
    ".jp-Dialog-content:has(.csSessionDetail)",
  );
  await createdDetail.getByText("READY", { exact: true }).waitFor({
    timeout: 20_000,
  });
  const controlBeforeCachedRestore = controlRequests.length;
  await createdDetail.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("session") === createdId &&
      url.searchParams.get("workspace") === createdId,
    { timeout: 20_000 },
  );
  await page.waitForFunction(() => {
    const categories = [
      ...document.querySelectorAll(".jp-Launcher-sectionTitle"),
    ].map((node) => node.textContent);
    return ["Notebook", "Console", "Other", "Sessions"].every((category) =>
      categories.includes(category),
    );
  });
  assert.equal(
    await page
      .locator(
        ".jp-MainAreaWidget:has(.jp-Launcher):has(#cybershuttle-session-panel)",
      )
      .count(),
    1,
    "direct-session restore must retain one combined Launcher",
  );
  const afterConnect = controlRequests.slice(controlBeforeCachedRestore);
  assert.ok(
    afterConnect.filter((entry) =>
      entry.endsWith(`/api/v1/sessions/${createdId}`),
    ).length >= 1,
    "the restored page must read the session it is attached to",
  );
  assert.deepEqual(
    afterConnect.filter(
      (entry) => entry.includes("/access") || entry.includes("/oauth/"),
    ),
    [`GET /api/v1/sessions/${createdId}/access`],
    "a session landing must reauthorize access without repeating OAuth",
  );
  const launcher = page.locator(".jp-Launcher");
  const contentsStart = directRequests.length;
  await launcher.getByText("Text File", { exact: true }).click();
  await waitForCondition(() =>
    directRequests
      .slice(contentsStart)
      .some(
        ({ method, path }) => method === "POST" && path === "/api/contents",
      ),
  );
  await page.getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByText("New Launcher", { exact: true }).click();
  await page.locator(".jp-Launcher").waitFor();
  await page
    .locator(
      ".jp-MainAreaWidget:has(.jp-Launcher):has(#cybershuttle-session-panel)",
    )
    .waitFor();
  assert.deepEqual(
    [
      await page.locator("#cybershuttle-session-panel").count(),
      await page.getByRole("button", { name: account, exact: true }).count(),
    ],
    [1, 1],
    "the section and its header must move to the launcher, not multiply or die with the old one",
  );
  await page
    .locator('.jp-LauncherCard[title="Start a new terminal session"]')
    .click();
  await waitForCondition(() =>
    directRequests
      .slice(contentsStart)
      .some(
        ({ method, path }) => method === "POST" && path === "/api/terminals",
      ),
  );
  await page.waitForTimeout(100);

  const managerRequests = directRequests.slice(contentsStart);
  assert.ok(
    managerRequests.some(
      ({ method, path }) => method === "POST" && path === "/api/contents",
    ),
    "native Text File action did not use the direct ContentsManager",
  );
  assert.ok(
    managerRequests.some(
      ({ method, path }) => method === "POST" && path === "/api/terminals",
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
          authorization === `token ${jupyterToken}` && cookie === "",
      ),
    "direct manager requests omitted the Jupyter token or sent cookies",
  );
  assert.deepEqual(directWebSockets, [
    `wss://31002.use.devtunnels.ms/terminals/websocket/1?token=${jupyterToken}`,
  ]);

  const controlBeforeReload = controlRequests.length;
  const directBeforeReload = directRequests.length;
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll(".jp-Launcher-sectionTitle").length > 0,
  );
  await waitForCondition(() => directRequests.length > directBeforeReload);
  assert.ok(
    directRequests
      .slice(directBeforeReload)
      .every(({ authorization }) => authorization === `token ${jupyterToken}`),
    "every call after a reload must still carry the Jupyter token",
  );
  assert.equal(
    controlRequests
      .slice(controlBeforeReload)
      .filter((entry) => entry.endsWith("/access")).length,
    1,
    "a session reload must reauthorize access",
  );
  const back = page.locator(".csSessionBack");
  assert.equal(
    await back.getAttribute("href"),
    `${staticOrigin}/lite/lab/index.html`,
  );
  assert.equal(
    await back
      .locator("svg")
      .evaluate((node) => node.getBoundingClientRect().height),
    24,
  );

  const signedOut = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: account, exact: true }).click();
  await page.locator('[data-session-action="sign-out"]').click();
  await signedOut;
  await signInPrompt.waitFor();
  assert.equal(page.url(), `${staticOrigin}/lite/lab/index.html`);
  const signedOutDirectRequests = directRequests.length;
  await page.waitForTimeout(500);
  assert.deepEqual(
    await page.evaluate(() => Object.keys(sessionStorage)),
    [],
    "sign-out must remove OAuth and every cached session access",
  );
  assert.equal(
    directRequests.length,
    signedOutDirectRequests,
    "the signed-out page must not reconnect to the remote Jupyter server",
  );

  assert.equal(
    controlRequests.some((entry) => entry.endsWith("/stop")),
    false,
    "connecting must not stop the session",
  );

  const EXPECTED_BROWSER_NOISE = [
    "Failed to load resource: the server responded with a status of 409 (Conflict)",
    "Cannot read properties of undefined (reading 'dimensions')",
  ];
  assert.deepEqual(
    browserErrors.filter((error) => !EXPECTED_BROWSER_NOISE.includes(error)),
    [],
  );
  console.log(
    `validated sign-in, guarded session access, remote Jupyter managers, and sign-out (${controlRequests.length} control requests)`,
  );
  await context.close();
} finally {
  webSockets.close();
  await browser.close();
  await close(staticServer);
  await close(controlServer);
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
        body: "<!doctype html><title>GitHub device sign in</title>",
      });
    },
  );
}

async function installIssuerRoute(context) {
  await context.route(`${issuerOrigin}/authorize**`, async (route) => {
    const request = route.request();
    assert.equal(request.method(), "GET");
    const url = new URL(request.url());
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    capturedAuthorize = {
      state: url.searchParams.get("state"),
      codeChallenge: url.searchParams.get("code_challenge"),
      redirectUri: url.searchParams.get("redirect_uri"),
    };
    const location = new URL(capturedAuthorize.redirectUri);
    location.searchParams.set("code", "browser-code");
    location.searchParams.set("state", capturedAuthorize.state);
    return route.fulfill({
      status: 302,
      headers: { location: location.toString() },
    });
  });
}

function tunnelLinkStatus() {
  return tunnelLinked
    ? {
        linked: true,
        provider: "github",
        account: "octocat",
        linkedAt: "2026-01-01T00:00:00Z",
      }
    : { linked: false };
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
function session(id, rootFolder, state = "READY") {
  return {
    id,
    seq,
    state,
    sshHost: "cluster",
    account: "project-a",
    partition: "debug",
    rootFolder,
    resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
    error: state === "FAILED" ? "Previous startup failed" : undefined,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
  };
}
async function readRequestJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function cors(response) {
  response.setHeader("access-control-allow-origin", staticOrigin);
  response.setHeader("access-control-expose-headers", "ETag, Location");
  response.setHeader("vary", "Origin");
}
function json(response, value, status = 200, headers = {}) {
  cors(response);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
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
