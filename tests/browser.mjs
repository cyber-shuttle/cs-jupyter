// Playwright end-to-end run against dist, driving real Chromium against a
// fake CyberShuttle API, a fake OAuth issuer, and a fake Jupyter server that
// answers on the CyberShuttle API's proxy path. It exercises PKCE sign-in and
// the session lifecycle through the real built extension.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
assert.ok(existsSync(join(dist, "lab", "index.html")), "dist is missing");

const clusterId = "9c2c0d01-f156-4f3a-9e4f-a2aebffa8ded";
const slurmClusterId = "c1d2e3f4-5678-4abc-9def-0123456789ab";
const deploymentId = "3f6a2c1e-8b7d-4e5f-9a0b-1c2d3e4f5a6b";
const templateId = "b6f1c2de-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const sessionId = sessionIdOf(1);
const startSessionId = sessionIdOf(2);
const deleteSessionId = sessionIdOf(3);
const createdSessionId = sessionIdOf(4);
const account = "user@example.edu";
const jupyterToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const issuerOrigin = "https://issuer.example.test";
let idToken = "";
let verifierUsed = "";
let capturedAuthorize;
let staticOrigin = "";
let planeOrigin = "";
let popupCount = 0;
const planeRequests = [];
const directRequests = [];
const directWebSockets = [];
const sessions = [
  sessionRecord(1),
  sessionRecord(2, "CANCELLED", false),
  sessionRecord(3, "COMPLETED", false),
];
let restarted = 100;

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
      cybershuttlePlaneApiUrl: `${planeOrigin}/api/v1`,
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

const planeServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", planeOrigin);
  if (request.method === "OPTIONS") {
    cors(response);
    response.writeHead(204, {
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
    });
    return response.end();
  }
  planeRequests.push(`${request.method} ${url.pathname}`);
  cors(response);
  if (url.pathname === "/api/v1/auth/config" && request.method === "GET") {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    return json(response, {
      issuer: issuerOrigin,
      authorization_endpoint: `${issuerOrigin}/authorize`,
      client_id: "cybershuttle-jupyter",
      scope: "openid email profile",
    });
  }
  if (url.pathname === "/api/v1/auth/token" && request.method === "POST") {
    assert.equal(request.headers.origin, staticOrigin);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    return readRequestJSON(request).then((body) => {
      assert.equal(body.code, "browser-code");
      assert.equal(typeof body.code_verifier, "string");
      assert.equal(
        createHash("sha256").update(body.code_verifier).digest("base64url"),
        capturedAuthorize?.codeChallenge,
        "the code verifier must hash to the challenge the authorize request carried",
      );
      assert.ok(
        body.redirect_uri.startsWith(staticOrigin),
        "the redirect URI must stay on the extension's own origin",
      );
      verifierUsed = body.code_verifier;
      const now = Math.floor(Date.now() / 1000);
      idToken = jwt({
        iss: issuerOrigin,
        aud: "cybershuttle-jupyter",
        sub: "owner",
        email: account,
        iat: now,
        exp: now + 3600,
      });
      return json(response, { id_token: idToken, expires_in: 900 });
    });
  }
  if (url.pathname.endsWith("/proxy/24000/api/v1/usage")) {
    assert.equal(request.headers.authorization, `token ${jupyterToken}`);
    return json(response, {});
  }
  if (request.headers.authorization !== `Bearer ${idToken}`)
    return json(response, { message: "unauthorized" }, 401, {
      "www-authenticate": "Bearer",
    });
  const lists = {
    "/api/v1/slurm-cluster-configs/me": [
      {
        slurmClusterConfigId: clusterId,
        slurmClusterId,
        name: "hpc-a",
        loginUser: "me",
        workRoot: "/home/me",
        sshCredential: { sshCredentialName: "laptop" },
      },
    ],
    "/api/v1/slurm-cluster-configs/shared-with-me": [],
    "/api/v1/slurm-deployments": [{ deploymentId, templateId, slurmClusterId }],
    "/api/v1/application-templates": [
      { templateId, templateName: "JupyterLab" },
    ],
    "/api/v1/sessions/me": sessions,
    "/api/v1/ssh-interactive-auths": [],
  };
  if (request.method === "GET" && lists[url.pathname])
    return json(response, lists[url.pathname]);
  if (
    url.pathname ===
      `/api/v1/slurm-cluster-configs/${clusterId}/discover-allocations` &&
    request.method === "POST"
  )
    return json(response, {
      allocations: [{ account: "project-a", partitions: [], qos: [] }],
      partitions: [
        { name: "debug", cpuPerNode: 16, maxMemory: 32768, gres: null },
      ],
    });
  if (url.pathname === "/api/v1/sessions" && request.method === "POST") {
    return readRequestJSON(request).then((body) => {
      assert.equal(body.slurmClusterConfigId, clusterId);
      assert.equal(body.deploymentId, deploymentId);
      assert.equal(body.account, "project-a");
      assert.equal(typeof body.resources.wallMinutes, "number");
      const item = sessionRecord(4, "SUBMITTED");
      Object.assign(item, {
        partition: body.partition,
        resources: body.resources,
      });
      sessions.push(item);
      setTimeout(() => setState(item, "READY"), 25);
      json(response, item, 201);
    });
  }
  const [, id, verb] =
    /^\/api\/v1\/sessions\/([0-9a-f-]{36})(?:\/(start))?$/.exec(url.pathname) ??
    [];
  const session = sessions.find((each) => each.sessionId === id);
  if (session && !verb && request.method === "GET")
    return json(response, session);
  if (session && !verb && request.method === "DELETE") {
    sessions.splice(sessions.indexOf(session), 1);
    response.writeHead(204);
    return response.end();
  }
  if (session && verb === "start" && request.method === "POST") {
    session.runs.unshift(runRecord(processIdOf(++restarted), "SUBMITTED"));
    setState(session, "SUBMITTED");
    return json(response, session);
  }
  const [, processId, action] =
    /^\/api\/v1\/processes\/([0-9a-f-]{36})\/([a-z]+)$/.exec(url.pathname) ??
    [];
  const run = sessions
    .flatMap((each) => each.runs)
    .find((each) => each.processId === processId);
  if (!run) return json(response, { message: "Route not found." }, 404);
  if (action === "statuses") return json(response, []);
  if (action === "access") {
    if (run.state !== "READY")
      return json(response, { message: "The job has no link" }, 409);
    return json(response, {
      processId,
      app: {
        uri: `${planeOrigin}/api/v1/processes/${processId}/proxy/24001/`,
        token: jupyterToken,
      },
    });
  }
  return json(response, { message: "Route not found." }, 404);
});

await listen(staticServer);
await listen(planeServer);
staticOrigin = serverOrigin(staticServer);
planeOrigin = serverOrigin(planeServer);

const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let page;
  context.on("page", (popup) => {
    if (page && popup !== page) popupCount++;
  });
  await installIssuerRoute(context);
  page = await context.newPage();
  const browserErrors = [];
  const browserMessages = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    browserMessages.push(message.text());
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await context.route(
    `${planeOrigin}/api/v1/processes/*/proxy/24001/**`,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const relative = url.pathname.split("/proxy/24001/")[1];
      directRequests.push({
        method: request.method(),
        path: `/${relative}`,
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
    },
  );
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
    "the product heading must appear once, in the Launcher content header",
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
    planeRequests,
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
    "hpc-a · JupyterLab, READY",
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
    Object.keys(browserState.sessionStorage).sort(),
    ["cybershuttle.connection.v1", "cybershuttle.oauth.v1"],
    "session storage holds only the credentials and this tab's connection id",
  );
  assert.ok(planeRequests.includes("GET /api/v1/sessions/me"));

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
    ["CyberShuttle Sessions", "CyberShuttle Sessions", "CyberShuttle Sessions"],
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

  await page.locator(`[data-session-action="${startSessionId}"]`).click();
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
    [["Start", "rgb(255, 255, 255)", "solid"]],
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
  await sessionDialog.getByRole("button", { name: "Start" }).click();
  await sessionDialog.getByText("SUBMITTED", { exact: true }).waitFor();
  assert.deepEqual(
    planeRequests.filter((entry) => entry.startsWith("POST /api/v1/sessions")),
    [`POST /api/v1/sessions/${startSessionId}/start`],
    "Start must launch the session that was never launched",
  );
  await sessionDialog.locator(".jp-Dialog-close-button").click();

  await page
    .locator(`[data-session-action="delete:${deleteSessionId}"]`)
    .click();
  await page
    .locator(".jp-Dialog")
    .filter({ hasText: "Delete session" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page
    .locator(`[data-session-action="${deleteSessionId}"]`)
    .waitFor({ state: "detached" });
  assert.ok(
    planeRequests.includes(`DELETE /api/v1/sessions/${deleteSessionId}`),
    "✕ must delete the ended session",
  );

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
  await page.getByLabel("Compute host").selectOption(clusterId);
  assert.equal(
    await page.getByLabel("Application").inputValue(),
    deploymentId,
    "a cluster's only deployment must be preselected",
  );
  await page.getByLabel("Partition").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const createdDetail = page.locator(
    ".jp-Dialog-content:has(.csSessionDetail)",
  );
  await createdDetail.getByText("READY", { exact: true }).waitFor({
    timeout: 20_000,
  });
  const createdRun = sessions.at(-1).runs[0].processId;
  const connect = createdDetail.getByRole("button", { name: "Connect" });
  await connect.waitFor();
  const planeBeforeCachedRestore = planeRequests.length;
  await connect.click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get("session") === createdSessionId &&
      url.searchParams.get("workspace") === createdSessionId,
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
  const afterConnect = planeRequests.slice(planeBeforeCachedRestore);
  assert.deepEqual(
    afterConnect.filter(
      (entry) =>
        entry === `GET /api/v1/sessions/${createdSessionId}` ||
        entry.includes(`${createdRun}/access`) ||
        entry.startsWith("POST /api/v1/auth/"),
    ),
    [
      `GET /api/v1/sessions/${createdSessionId}`,
      `GET /api/v1/processes/${createdRun}/access`,
    ],
    "a session landing must read its session, then reauthorize access without repeating OAuth",
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
    "the section and its header must move to the Launcher, not multiply or die with the old one",
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
    `${planeOrigin.replace(/^http/, "ws")}/api/v1/processes/${createdRun}/proxy/24001/terminals/websocket/1?token=${jupyterToken}`,
  ]);

  const planeBeforeReload = planeRequests.length;
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
    planeRequests
      .slice(planeBeforeReload)
      .filter((entry) => entry.endsWith(`${createdRun}/access`)).length,
    1,
    "a session reload must reauthorize access",
  );
  const back = page.locator(".csSessionBack");
  assert.equal(
    await back.getAttribute("href"),
    `${staticOrigin}/lite/lab/index.html`,
  );
  // One in-page read: the list rebuilds on a clock, so a resolved node can detach before it is measured.
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector(".csSessionBack svg").getBoundingClientRect()
          .height,
    ),
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
    "sign-out must leave nothing in session storage",
  );
  assert.equal(
    directRequests.length,
    signedOutDirectRequests,
    "the signed-out page must not reconnect to the remote Jupyter server",
  );

  const EXPECTED_BROWSER_NOISE = [
    "Cannot read properties of undefined (reading 'dimensions')",
  ];
  assert.deepEqual(
    browserErrors.filter((error) => !EXPECTED_BROWSER_NOISE.includes(error)),
    [],
  );
  assert.ok(
    planeRequests.some((entry) => entry.endsWith("/proxy/24000/api/v1/usage")),
    "a linked session's usage must be read through its proxy",
  );
  console.log(
    `validated sign-in, guarded session access, remote Jupyter managers, and sign-out (${planeRequests.length} the CyberShuttle API requests)`,
  );
  await context.close();
} finally {
  await browser.close();
  await close(staticServer);
  await close(planeServer);
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
function processIdOf(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
function sessionIdOf(n) {
  return `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
function runRecord(processId, state) {
  return {
    processId,
    controlPort: 24000,
    state,
    startedAt: null,
    deadline: null,
    endedAt: null,
    error: null,
  };
}
function sessionRecord(n, state = "READY", live = true) {
  return {
    sessionId: sessionIdOf(n),
    createdAt: Date.UTC(2026, 0, 1, 0, 0, n),
    slurmClusterConfigId: clusterId,
    deploymentId,
    account: "project-a",
    partition: "debug",
    resources: { cores: 4, memoryMb: 4096, wallMinutes: 30 },
    state,
    live,
    runs: [runRecord(processIdOf(n), state)],
  };
}
function setState(session, state) {
  session.state = session.runs[0].state = state;
  session.live = !["COMPLETED", "FAILED", "CANCELLED"].includes(state);
}
async function readRequestJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function cors(response) {
  response.setHeader("access-control-allow-origin", staticOrigin);
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
