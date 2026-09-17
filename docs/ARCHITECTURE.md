# Architecture

The distribution is a static JupyterLite site plus one federated extension (`src/index.ts`). It speaks to two
parties: the cs-control API configured at deployment time, and the Jupyter server inside a Slurm session,
reached directly over that session's Dev Tunnel. cs-control serves neither this application nor session
traffic, so every control call is cross-origin and pinned to the configured origin.

## Configuration

One `PageConfig` option, `cybershuttleControlApiUrl`, points a deployment at its cs-control API. It must be an
absolute URL using HTTPS or loopback HTTP — relative and implicit same-origin values are rejected. cs-control
listens on loopback, so a deployment normally names a loopback URL, and the cs-control each user runs must
list this site's own origin under `--allowed-origin`. The OIDC issuer, client and Custos URL are configured
only on cs-control; this client reads the authorization endpoint from `GET /api/v1/oauth/config` and holds no
client secret.
[DEPLOYING.md](DEPLOYING.md) covers where the option goes.

## Sign-in

Only after the user clicks **Sign in** does the browser fetch `GET /api/v1/oauth/config`, store a PKCE
verifier, a `state` and the page to return to under `cybershuttle.oauth.pkce.v1`, and navigate to CILogon's
authorization endpoint. CILogon redirects back to the same page with `code` and `state`; the next load posts
them with the verifier to `POST /api/v1/oauth/exchange`, which holds the client secret, and restores the
original URL. App restore, panel construction, cached session access and polling never start sign-in.

The ID token and refresh token live in per-tab `sessionStorage` under `cybershuttle.oauth.v1`, so the reload
that opens a session does not repeat the redirect. They are never written to `localStorage`, a URL, a log or
an error. A minute before expiry the token is renewed through `POST /api/v1/oauth/refresh`; once expired
without a renewal it is dropped and **Sign in** is offered again.

Sessions run over the user's own Dev Tunnels account, linked once. When session creation answers
`409 tunnel_link_required`, the Add Session dialog hosts the link step in place: a Microsoft or GitHub
device-code authorization started at `POST /api/v1/tunnel/link/start`, shown as a verification URI and one-time
code with explicit copy, open and cancel actions, and polled at `POST /api/v1/tunnel/link/poll/{handle}` until
linked, after which the create is retried. The credential never reaches this client; cs-control seals it.
The account menu's **Dev Tunnels** dialog reads and unlinks it through `GET` and `DELETE /api/v1/tunnel/link`.

## Trust boundaries

Every credential this app carries, and where it goes:

| Hop                | Route                                                                                   | Credential                                      |
| ------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Sign-in relay      | `GET /api/v1/oauth/config`, `POST /api/v1/oauth/exchange`, `POST /api/v1/oauth/refresh` | none (`credentials: omit`, `redirect: "error"`) |
| Control API        | `/api/v1/*`                                                                             | `Authorization: Bearer <ID token>`              |
| SSH authentication | `WS /api/v1/ssh/{alias}/auth`                                                           | the ID token as the `bearer.` subprotocol       |
| Jupyter            | the session's Dev Tunnel origin                                                         | the seq-bound Jupyter token                     |

The control API uses no cookies, XSRF header or same-origin proxy. The SSH socket offers exactly
`cybershuttle.v1` plus the credential subprotocol and fails closed unless the server negotiates
`cybershuttle.v1`; tokens never appear in a WebSocket URL. The routes and their trust boundaries are
cs-control's, and [cyber-shuttle/cs-control](https://github.com/cyber-shuttle/cs-control) is the canonical
description of them.

Every response is checked against a shared `Validator` vocabulary in `src/Common.ts` before `src/ControlClient.ts`
hands it to the rest of the app: an object validator rejects a field it does not list as well as one it is
missing or of the wrong type, so an unexpected cs-control shape fails closed instead of passing through.

## Session flow

1. The native Launcher manages SSH hosts and sessions through the configured cross-origin cs-control API.
2. One authenticated read of `GET /api/v1/sessions`, polled once a second, supplies the session state
   (`SUBMITTING`, `QUEUED`, `STARTING`, `READY`, `STOPPING`, `STOPPED`, `FAILED`) and the startup tails.
3. A `STOPPED` or `FAILED` session is gone. "Run again" submits a new one under the same card and settings
   rather than resuming a dead job, and the card reads `SUBMITTING` from the click until that request
   answers, so it never offers a second run over one already in flight.
4. Connect is available once the session state is `READY` and an access response has been fetched for it. The
   client directly requests the separate owner-authenticated session-access response; no Dev Tunnel popup or
   cookie bootstrap is used.
5. The client stores that exact seq-bound access response only in `sessionStorage`, reloads with the
   nonsecret session ID as `session` and `workspace` in its static query, and points JupyterLab's Contents, `api/kernels`,
   `api/kernelspecs`, `api/sessions`, and `api/terminals` managers directly at the Jupyter HTTPS/WSS Dev
   Tunnel URI. Those managers use JupyterLab's own `ServerConnection` token handling: `Authorization: token
<token>` on REST and `?token=` on the Jupyter WebSocket URLs.

Each session's JupyterLab layout is kept in the session's own home at `.cybershuttle/workspaces/<id>.json`
through its contents API, in place of JupyterLite's browser-local workspace, so switching back to a session
restores its tabs. cs-control asks Linkspan, the session's main process, for the Jupyter server; Linkspan builds the Python
environment on the compute host and starts the server on the port cs-control declared. Nothing in this
repository runs there.

## Countdown, usage and history

Two reads sit beside the poll, each separate from it for a reason, plus the status bar's own 30-second read.

The countdown is not a read at all. `startedAt` is when Slurm was first seen running the session, so with
`resources.wallMinutes` it is an absolute deadline the client ticks down against its own clock. That matters
because the poll goes quiet: a queued session is answered `304` and emits no state for minutes at a time,
so each surface showing the figure runs a one-second clock of its own. The status-bar item reads cs-control
directly, on its own 30-second `getSession` poll, rather than borrowing the Launcher's state, because
JupyterLab disposes the Launcher the moment anything is opened from it, and the countdown has to outlive
that. Below ten minutes every surface warns, on one threshold.

Usage samples are their own route because they change on every tick, and folding them into the poll would
defeat the `ETag` that makes watching a queued job cheap. Every live session is read, whether or not its detail
dialog is open, because the run history shows the same figures for a session that is still going. Each series
is drawn against Slurm's allocated cores when sacct has reported them, falling back to what the job spec
requested, rather than against its own maximum, so an idle job cannot look busy.

Run history is its own collection rather than a view of the session list, because it outlives it: a run whose
card was deleted is still the caller's. The same report renders for a card whose session just ended and for
a run read back out of the history, because they are the same record.

## Session access

Session access intentionally keeps the token across same-tab reloads so an active session remains
usable while cs-control is unavailable. It is never written to localStorage, the page URL, logs, errors, or
session cards. An entry for another session or seq, or one whose expiry has passed, is discarded on
read, and the Dev Tunnel URI it names must be a bare `*.devtunnels.ms` origin.

## Fail-closed compute

There is no local kernel fallback; the Launcher and all compute managers remain fail-closed until a valid
`READY` seq is selected. Without one, `src/index.ts` substitutes server settings that answer
`api/contents` with an empty read-only directory, `api/kernels`, `api/sessions` and `api/terminals` with an
empty list, `api/kernelspecs` with no specification, and everything else with `503`. Terminals are a
`NoopManager` and `terminalsAvailable` is `false`, so the terminal UI never activates. The build carries no
in-browser kernel to fall back to: `tests/distribution.mjs` fails if a Pyodide, xeus or JavaScript-kernel
asset appears in `dist/`.
