# Contributing to CyberShuttle Jupyter

Issues and pull requests go through GitHub. Branch off `main`, keep CI green, cover new behaviour with a
test, and say in the description what you ran. There is no CLA or sign-off requirement. Participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go through [SECURITY.md](SECURITY.md),
not a public issue or pull request.

## Development setup

### Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.com/) — every command below is a Bun script
- [uv](https://docs.astral.sh/uv/) — drives the Python build tools
- Python 3.11 or newer (`pyproject.toml`)
- Chromium, only for the browser end-to-end run: `bunx playwright install --with-deps chromium`

CI pins no Bun, uv or Python version; it installs the current release of each. There is no application
Python and no backend service: the build produces static files.

### Getting started

```bash
git clone https://github.com/cyber-shuttle/cs-jupyter.git
cd cs-jupyter

bun install --frozen-lockfile
uv sync --frozen
bun run dev
```

`bun run dev` compiles the extension and serves the site locally. It reads the same `jupyter-lite.json` a
deployment does, so set `cybershuttleControlApiUrl` to a `csctl serve` you are running — loopback HTTP is
accepted. See [docs/DEPLOYING.md](docs/DEPLOYING.md).

## Scripts

| Script                    | What it does                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ |
| `bun run build`           | `clean`, then compile TypeScript and build the extension and site into `dist/` |
| `bun run build:lib`       | `tsc -b` into `lib/`                                                           |
| `bun run build:extension` | Build the federated extension into `labextension/`                             |
| `bun run build:lite`      | Build the extension, then the JupyterLite site                                 |
| `bun run clean`           | Remove `lib/`, `labextension/`, `dist/` and the build caches                   |
| `bun run dev`             | Compile the extension and serve the site                                       |
| `bun run typecheck`       | `tsc` over `src/` and `tests/`                                                 |
| `bun run lint`            | `typecheck`, then `prettier --check .`                                         |
| `bun run test`            | Vitest unit tests (`tests/**/*.test.ts`, jsdom)                                |
| `bun run test:dist`       | Assert the built static contract of `dist/`                                    |
| `bun run test:browser`    | Playwright end-to-end run against `dist/`                                      |
| `bun run test:all`        | `test`, `test:dist`, `test:browser`                                            |

`test:dist` and `test:browser` read the build output and fail immediately if `dist/` is missing, so
`bun run build` must precede them and `bun run test:all`. `test:browser` drives real Chromium against fake
cs-control and Jupyter servers on separate origins, so it also needs the Playwright browser install above.

## What CI enforces

`.github/workflows/ci.yml` runs on every pull request and every push to `main`, in two jobs:

- **test** — `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`
- **e2e** — `bun install --frozen-lockfile`, `uv sync --frozen`, `bun run build`, `bun run test:dist`,
  `bunx playwright install --with-deps chromium`, `bun run test:browser`

CI does not gate formatting, so run `bun run lint` yourself before opening a pull request.

## Source layout

```
cs-jupyter
├── src/
│   ├── index.ts              # extension entry: service-manager plugins, fail-closed server settings
│   ├── AuthClient.ts         # device-code broker client, sign-in dialog, sessionStorage credentials
│   ├── ControlClient.ts      # typed cs-control REST/WebSocket client and response validation
│   ├── OAuthWebSocket.ts     # credential-carrying WebSocket subprotocols
│   ├── runtime-access.ts     # generation-bound access cache, Dev Tunnel host allowlist
│   ├── runtime-ui.ts         # Launcher integration, runtime selection in the page query
│   ├── runtime-state.ts      # the selected runtime id, in memory
│   ├── CyberShuttlePanel.ts  # runtimes panel and its poll loop
│   ├── RuntimeList.ts        # runtime cards and their actions
│   ├── RuntimeDetail.ts      # one runtime's detail view and status log
│   ├── RuntimeController.ts  # opening a runtime and guarding commands that need one
│   ├── CreateRuntimeForm.ts  # Slurm allocation form, validation and script preview
│   ├── SshHosts.ts           # SSH host list, add, test and remove
│   ├── SshLoginDock.ts       # interactive SSH login surface
│   ├── SshOperationConsole.ts # xterm.js console over the SSH WebSocket
│   ├── Common.ts             # shared types, identifier and URL rules
│   └── dom.ts                # element helpers
├── style/                    # CSS shipped with the extension
├── tests/                    # Vitest units, distribution.mjs, browser.mjs and fixtures
├── jupyter-lite.json         # PageConfig for the built site
└── jupyter_lite_config.json  # JupyterLite build configuration
```

Every cs-control response is validated in `ControlClient.ts` against the types and identifier rules in
`Common.ts`; a change to the wire contract belongs there and in
`tests/fixtures/cs-control-runtime-contract.json`, which `tests/runtime-contract.test.ts` pins.

## Releases

There is no release process yet: no tags, and nothing published to npm or PyPI (`package.json` is `private`,
`pyproject.toml` sets `package = false`). The artifact is the `dist/` directory a deployer builds, so a
change reaches users when they rebuild and redeploy. Add user-visible changes to the `## [Unreleased]`
section of [CHANGELOG.md](CHANGELOG.md) in the same pull request.
