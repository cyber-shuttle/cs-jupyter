// Asserts the built static contract of dist: the files a deployer actually
// ships. It reads them back the way a browser would, rather than through tsc.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const dist = new URL("../dist/", import.meta.url);
assert.ok(existsSync(dist), "dist/ is missing; run bun run build first");

const configText = readFileSync(new URL("jupyter-lite.json", dist), "utf8");
const config = JSON.parse(configText)["jupyter-config-data"];
const extensionNames = (config.federated_extensions ?? []).map(
  ({ name }) => name,
);
assert.ok(
  extensionNames.includes("@cybershuttle/jupyter"),
  "remote adapter is missing from the distribution",
);
assert.equal(
  config.cybershuttleControlApiUrl,
  "",
  "control endpoint must be deployment-configured",
);
for (const key of [
  "cybershuttleClientId",
  "cybershuttleAuthority",
  "cybershuttleDevTunnelsScope",
]) {
  assert.ok(
    !(key in config),
    `OAuth client configuration must not be present: ${key}`,
  );
}
assert.ok(
  !config.disabledExtensions.includes(
    "@jupyterlab/services-extension:server-settings",
  ),
  "local shell server settings must remain enabled",
);
for (const plugin of [
  "@jupyterlab/services-extension:service-manager",
  "@jupyterlab/services-extension:contents-manager",
  "@jupyterlab/terminal-extension:open-folder-in-terminal",
]) {
  assert.ok(
    config.disabledExtensions.includes(plugin),
    `upstream service plugin must be disabled: ${plugin}`,
  );
}
assert.ok(
  !config.disabledExtensions.includes("@jupyterlab/terminal-extension:plugin"),
  "remote terminal extension must remain available to a READY session",
);
assert.ok(
  config.deferredExtensions.includes("@jupyterlab/terminal-extension:plugin"),
  "terminal UI must wait for the READY-gated remote service manager",
);

const forbidden = ["pyodide", "xeus", "javascript-kernel"];
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const paths = walk(dist.pathname).map((path) => path.toLowerCase());
for (const provider of forbidden) {
  assert.ok(
    paths.every((path) => !path.includes(provider)),
    `local kernel provider asset found: ${provider}`,
  );
  assert.ok(
    extensionNames.every((name) => !name.toLowerCase().includes(provider)),
    `local kernel provider extension found: ${provider}`,
  );
}

console.log(
  `validated ${paths.length} static files: local shell settings, remote compute managers, session selection, and no local kernel provider assets`,
);
