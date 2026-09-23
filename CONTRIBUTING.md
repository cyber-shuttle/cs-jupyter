# Contributing to CyberShuttle Jupyter

Branch off `main`, keep CI green, cover new behaviour with a test, and state in the pull request what you ran.
No CLA or sign-off. The [Code of Conduct](CODE_OF_CONDUCT.md) applies. Vulnerabilities go through
[SECURITY.md](SECURITY.md), not a public issue.

## Setup

Requires [Bun](https://bun.com/), [uv](https://docs.astral.sh/uv/), Python 3.11+, and for `test:browser` only,
Chromium (`bunx playwright install --with-deps chromium`).

```bash
git clone https://github.com/cyber-shuttle/cs-jupyter.git && cd cs-jupyter
bun install --frozen-lockfile
uv sync --frozen
lefthook install   # optional: typecheck, prettier and unit tests before each commit
bun run dev
```

`bun run dev` serves the site from the same `jupyter-lite.json` a deployment uses; set
`cybershuttleControlApiUrl` there as in [docs/DEPLOYING.md](docs/DEPLOYING.md). Loopback HTTP is accepted.

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
| `bun run test:dist`       | Assert the static contract of the built `dist/`                                |
| `bun run test:browser`    | Playwright run of `dist/` against fake cs-plane and Jupyter servers            |
| `bun run test:all`        | `test`, `test:dist`, `test:browser`                                            |

`test:dist`, `test:browser` and `test:all` need a prior `bun run build`.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

| Job    | Steps                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------- |
| `test` | `bun install --frozen-lockfile`, `bun run lint`, `bun run test`                                       |
| `e2e`  | `uv sync --frozen`, `bun run build`, `bun run test:dist`, Playwright Chromium, `bun run test:browser` |

## Source layout

Each `src/` file opens with a doc comment stating its role. Entry points:

| Path                             | Role                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `src/index.ts`                   | Extension plugins; fail-closed server settings                     |
| `src/ControlClient.ts`           | cs-plane REST/WebSocket client and response validation             |
| `src/Common.ts`                  | Shared types, `Validator` vocabulary, identifier and URL rules     |
| `src/AuthClient.ts`              | CILogon sign-in with PKCE through cs-plane                         |
| `src/CyberShuttlePanel.ts`       | Launcher controller: poll, sign-in state, dialogs                  |
| `tests/session-contract.test.ts` | Pins the cs-plane wire contract; change it with `ControlClient.ts` |
| `jupyter-lite.json`              | PageConfig of the built site                                       |
| `jupyter_lite_config.json`       | JupyterLite build configuration                                    |

## Releases

None: `package.json` is `private` and `pyproject.toml` sets `package = false`. Deployers rebuild `dist/` to take
changes. Record user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) in the same pull
request.
