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

- **test** — `bun install --frozen-lockfile`, `bun run lint`, `bun run test`
- **e2e** — `bun install --frozen-lockfile`, `uv sync --frozen`, `bun run build`, `bun run test:dist`,
  `bunx playwright install --with-deps chromium`, `bun run test:browser`

CI runs `bun run lint`, which is `typecheck` then `prettier --check .`, so it gates formatting too.
`lefthook.yml` runs `typecheck`, `prettier --check` and the unit tests before every commit, so a commit is
formatted and green; `lefthook install` wires it once per clone.

## Source layout

```
cs-jupyter
├── src/
│   ├── index.ts               # extension entry: service-manager plugins, fail-closed server settings
│   ├── AuthClient.ts          # CILogon sign-in with PKCE through cs-control's relay, sessionStorage credentials
│   ├── DeviceCodeDialog.ts    # the accessible device-code modal the Dev Tunnels link uses
│   ├── TunnelLink.ts          # the Dev Tunnels link: status, unlink, and the Microsoft or GitHub device flow
│   ├── workspaces.ts          # per-session JupyterLab layout kept in the session's own home
│   ├── ControlClient.ts       # typed cs-control REST/WebSocket client and response validation
│   ├── ssh.ts                 # OAuth WebSocket subprotocols, the SSH terminal console and its login dock
│   ├── session.ts             # session identity/selection, the UI state shape, and the seq-bound access cache
│   ├── session-ui.ts          # Launcher integration
│   ├── CyberShuttlePanel.ts   # the stateful controller: poll, list, sign-in/out, title row; composes actions and modals
│   ├── session-actions.ts     # connect, run again, stop, delete and the Jupyter access they need
│   ├── modals.ts              # the panel's dialogs: session detail, Add Session, hosts, history
│   ├── RebuildingWidget.ts    # shared full-rebuild render loop, focus restore and countdown redraw
│   ├── SessionList.ts         # session cards and their actions
│   ├── SessionDetail.ts       # one session's detail view and status log
│   ├── SessionController.ts   # opening a session and guarding commands that need one
│   ├── RunHistory.ts          # every run this account has made, live and finished
│   ├── CreateSessionForm.ts   # the multi-step wizard shell, and the partition/GPU option and bounds logic
│   ├── SlurmDiscovery.ts      # SSH host selection, Slurm discovery, SSH interactive login
│   ├── ReviewStep.ts          # validation, script preview and submit
│   ├── SshHosts.ts            # SSH host list, add, edit, test and remove
│   ├── metrics.ts             # accounting and sample series to summaries, sparklines, usage plots and the status-bar countdown
│   ├── Common.ts              # shared types, identifier/URL rules, JSON response builder
│   └── dom.ts                 # element, grid, log-section and disclosure builders, plus walltime countdown arithmetic and the remaining-time badge
├── style/                    # CSS shipped with the extension
├── tests/                    # Vitest units, distribution.mjs, browser.mjs and fixtures
├── jupyter-lite.json         # PageConfig for the built site
└── jupyter_lite_config.json  # JupyterLite build configuration
```

Every cs-control response is validated in `ControlClient.ts` against the types and identifier rules in
`Common.ts`; a change to the wire contract belongs there and in
`tests/fixtures/cs-control-session-contract.json`, which `tests/session-contract.test.ts` pins.

## Releases

There is no release process yet: no tags, and nothing published to npm or PyPI (`package.json` is `private`,
`pyproject.toml` sets `package = false`). The artifact is the `dist/` directory a deployer builds, so a
change reaches users when they rebuild and redeploy. Add user-visible changes to the `## [Unreleased]`
section of [CHANGELOG.md](CHANGELOG.md) in the same pull request.
