# Architecture

The distribution is a static JupyterLite site plus one federated extension (`src/index.ts`). It speaks to two
parties: the cs-control API configured at deployment time, and the Jupyter server inside a Slurm allocation,
reached directly over that allocation's Dev Tunnel. cs-control serves neither this application nor runtime
traffic, so every control call is cross-origin and pinned to the configured origin.

## Configuration

One `PageConfig` option, `cybershuttleControlApiUrl`, points a deployment at its cs-control API. It must be an
absolute URL using HTTPS or loopback HTTP — relative and implicit same-origin values are rejected. cs-control
listens on loopback, so a deployment normally names a loopback URL, and the cs-control each user runs must
list this site's own origin under `--allowed-origin`. The tenant-specific Microsoft authority is configured
only on cs-control; this client has no authority, scope, native client ID, SPA client, or MSAL configuration.
[DEPLOYING.md](DEPLOYING.md) covers where the option goes.

## Sign-in

Only after the user clicks the Launcher's **Sign in** action, the browser asks the configured cs-control
endpoint to start and poll its memory-only Microsoft device-code broker. This client never calls Microsoft
OAuth endpoints. It displays the verification URI and one-time user code in an accessible dialog with
explicit copy, open, and cancel actions. No redirect URI, SPA registration, popup authorization, or automatic
interaction is used. App restore, panel construction, cached direct-runtime restore, and polling never start
OAuth. Each successful token response supplies both the opaque Dev Tunnels access token and its signed
Microsoft ID token; cs-control discards any returned refresh token before responding.

Those credentials live in per-tab `sessionStorage` under `cybershuttle.oauth.v1`, so the reload that opens a
runtime does not repeat the device-code round trip. They are never written to `localStorage`, a URL, a log or
an error. When they expire, polling suspends without retrying and the Sign in action is enabled again.

## Trust boundaries

Every credential this app carries, and where it goes:

| Hop                | Route                                                                   | Credential                                                           |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Device sign-in     | `POST /api/v1/oauth/device/start`, `/api/v1/oauth/device/poll/{handle}` | none (`credentials: omit`, `redirect: "error"`)                      |
| Control API        | `/api/v1/*`                                                             | `Authorization: Bearer <access>` and `X-CyberShuttle-Identity: <ID>` |
| SSH authentication | `WS /api/v1/ssh/{alias}/auth`                                           | the two tokens as `bearer.` and `identity.` subprotocols             |
| Jupyter            | the allocation's Dev Tunnel origin                                      | the generation-bound Jupyter token                                   |

The control API uses no cookies, XSRF header or same-origin proxy. The SSH socket offers exactly
`cybershuttle.v1` plus the two credential subprotocols and fails closed unless the server negotiates
`cybershuttle.v1`; tokens never appear in a WebSocket URL. The routes and their trust boundaries are
cs-control's, and [cyber-shuttle/cs-control](https://github.com/cyber-shuttle/cs-control) is the canonical
description of them.

## Runtime flow

1. The native Launcher manages SSH hosts and allocations through the configured cross-origin cs-control API.
2. One authenticated read of `GET /api/v1/runtimes`, polled once a second, supplies the runtime state
   (`SUBMITTING`, `QUEUED`, `STARTING`, `READY`, `STOPPING`, `STOPPED`, `FAILED`) and the startup tails.
3. A `STOPPED` or `FAILED` allocation is gone. "Run again" submits a new one under the same card and settings
   rather than resuming a dead job, and the card reads `SUBMITTING` from the click until that request
   answers, so it never offers a second run over one already in flight.
4. Connect is available once the runtime state is `READY` and an access response has been fetched for it. The
   client directly requests the separate owner-authenticated runtime-access response; no Dev Tunnel popup or
   cookie bootstrap is used.
5. The client stores that exact generation-bound access response only in `sessionStorage`, reloads with the
   nonsecret runtime ID and generation in its static query, and configures Contents, Kernel, KernelSpec,
   Session, and Terminal managers directly against the Jupyter HTTPS/WSS Dev Tunnel URI. Those managers use
   JupyterLab's own `ServerConnection` token handling: `Authorization: token <capability>` on REST and
   `?token=` on the Jupyter WebSocket URLs.

cs-control asks Linkspan, the allocation's main process, for the Jupyter server; Linkspan builds the Python
environment on the compute host and starts the server on the port cs-control declared. Nothing in this
repository runs there.

## Countdown, usage and history

Three reads sit beside the poll, each separate from it for a reason.

The countdown is not a read at all. `startedAt` is when Slurm was first seen running the allocation, so with
`resources.wallMinutes` it is an absolute deadline the client ticks down against its own clock. That matters
because the poll goes quiet: a settled allocation is answered `304` and emits no state for minutes at a time,
so every surface showing the figure — the card, the detail dialog, and a status-bar item on the runtime's own
page — runs a one-second clock of its own. The status-bar item reads cs-control directly rather than borrowing
the Launcher's state, because JupyterLab disposes the Launcher the moment anything is opened from it, and the
countdown has to outlive that. Below ten minutes every surface warns, on one threshold.

Usage samples are their own route because they change on every tick, and folding them into the poll would
defeat the `ETag` that makes watching a queued job cheap. They are read only while a runtime's detail dialog is
open: cs-control keeps a window for every allocation, but reading one nobody is looking at is a round trip for
a graph nobody sees. Each series is drawn against what the allocation was given rather than against its own
maximum, so an idle job cannot look busy.

Run history is its own collection rather than a view of the runtime list, because it outlives it: a run whose
card was deleted is still the caller's. The same report renders for a card whose allocation just ended and for
a run read back out of the history, because they are the same record.

## Session cache

The session cache intentionally keeps the capability across same-tab reloads so an active runtime remains
usable while cs-control is unavailable. It is never written to localStorage, the page URL, logs, errors, or
runtime cards. An entry for another runtime or generation, or one whose expiry has passed, is discarded on
read, and the Dev Tunnel URI it names must be a bare `*.devtunnels.ms` origin.

## Fail-closed compute

There is no local kernel fallback; the Launcher and all compute managers remain fail-closed until a valid
`READY` generation is selected. Without one, `src/index.ts` substitutes server settings that answer
`api/contents` with an empty read-only directory, `api/kernels`, `api/sessions` and `api/terminals` with an
empty list, `api/kernelspecs` with no specification, and everything else with `503`. Terminals are a
`NoopManager` and `terminalsAvailable` is `false`, so the terminal UI never activates. The build carries no
in-browser kernel to fall back to: `tests/distribution.mjs` fails if a Pyodide, xeus or JavaScript-kernel
asset appears in `dist/`.
