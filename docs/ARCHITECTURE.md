# Architecture

A static JupyterLite site plus one federated extension (`src/index.ts`). It talks to one origin, the cs-plane
API named by `cybershuttleControlApiUrl` ([DEPLOYING.md](DEPLOYING.md)), which also proxies each session's
Jupyter server. cs-plane does not serve this site, so every call is cross-origin. The routes are defined by
[cs-plane](https://github.com/cyber-shuttle/cs-plane); this file records what the client relies on.

## Routes and credentials

Paths are relative to `cybershuttleControlApiUrl` (`…/api/v1`).

| Route                                                                                    | Use                             | Credential                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| `GET oauth/config`, `POST oauth/exchange`, `POST oauth/refresh`                          | Sign-in relay                   | none (`credentials: "omit"`, `redirect: "error"`) |
| `GET`, `POST sessions`; `POST sessions/validate`                                         | List (`ETag`/`304`), create     | `Authorization: Bearer <ID token>`                |
| `GET`, `DELETE sessions/{id}`; `POST sessions/{id}/start`, `/stop`                       | Status, run again, stop, delete | Bearer                                            |
| `GET sessions/{id}/metrics`, `GET telemetry`                                             | Usage samples, run history      | Bearer                                            |
| `GET sessions/{id}/access`                                                               | Seq-bound Jupyter URI and token | Bearer                                            |
| `GET`, `POST hosts`; `PUT`, `DELETE hosts/{alias}`; `GET hosts/{alias}/health`, `/slurm` | SSH hosts, Slurm discovery      | Bearer                                            |
| `WS hosts/{alias}/ssh`                                                                   | Interactive SSH login           | ID token as the `bearer.` subprotocol             |
| `GET`, `POST keys/ssh`; `DELETE keys/ssh/{id}`                                           | SSH keys                        | Bearer                                            |
| `GET`, `DELETE tunnel`; `POST tunnel/authorizations`, `/{handle}/poll`                   | Dev Tunnels link                | Bearer                                            |
| `sessions/{id}/jupyter/`                                                                 | Jupyter REST and WebSocket      | Jupyter token (`Authorization: token`, `?token=`) |

- Control requests go through `safeControlFetch`: same origin as the configured URL, `credentials: "omit"`,
  `redirect: "error"`, `cache: "no-store"`; no cookies or XSRF header. A `401` drops the ID token.
- The SSH socket offers `cybershuttle.v1` plus the bearer subprotocol and fails unless the server selects
  `cybershuttle.v1`.
- Errors are `{"error": {"code", "message"}}`. The client acts on `ssh_authentication_required` (opens the
  login console, retries once) and `session_access_unavailable` (`409` while a session leaves `READY`).
- Every response passes a `Validator` from `src/Common.ts`; an object validator rejects unknown keys, so an
  unexpected shape fails closed.

## Sign-in

Clicking **Sign in** is the only trigger. The client reads the authorization endpoint from `oauth/config`,
stores a PKCE verifier, `state` and return URL under `sessionStorage` key `cybershuttle.oauth.pkce.v1`, and
navigates to CILogon. On return, the next load posts `code`, `state` and the verifier to `oauth/exchange`
(cs-plane holds the client secret) and restores the URL. Tokens live under `cybershuttle.oauth.v1`, are refreshed
through `oauth/refresh` a minute before expiry, and are dropped once expired.

A linked Dev Tunnels account is optional; cs-plane delegates a Dev Tunnel to each session as a fallback route.
The client drives the device-code flow and shows the verification URI and code; cs-plane keeps the credential.

## Session lifecycle

| State                              | Client behaviour                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SUBMITTING`, `QUEUED`, `STARTING` | Polled; startup log shown                                                                        |
| `READY`                            | Access fetched; **Connect** enabled                                                              |
| `STOPPING`                         | Polled                                                                                           |
| `STOPPED`, `FAILED`                | Terminal. **Run again** submits a new job under the same card, shown `SUBMITTING` until answered |

Every second the Launcher reads `sessions`, then `sessions/{id}/metrics` for each live session and `telemetry`.

Once a session is `READY`, the Launcher caches its access response, with the seq it was granted for, in
`sessionStorage`. **Connect** reloads with `?session=<id>&workspace=<id>`; only the session ID enters the URL.
On load `src/index.ts` requests fresh access, requires its Jupyter URI to equal
`sessions/<id>/jupyter/` under the control API URL, and points JupyterLab's contents, kernels, kernelspecs,
sessions and terminals managers at it. A `401` or `403` from Jupyter drops the grant; sign-out clears all grants
and leaves the session page.

The JupyterLab layout is stored in the session's home at `.cybershuttle/workspaces/<id>.json`, replacing
JupyterLite's browser-local workspace. Linkspan, launched by cs-plane, builds the Python environment and starts
Jupyter on the compute node; nothing from this repository runs there.

## Countdown and usage

- Deadline = `startedAt` + `resources.wallMinutes`, ticked locally each second, since a queued session's poll
  returns `304` for minutes.
- The status-bar countdown polls `GET sessions/{id}` every 30 s itself, because JupyterLab disposes the Launcher
  once anything opens from it.
- Every surface warns below ten minutes.
- CPU usage is plotted against Slurm's allocated cores when reported, else the requested cores.

## Fail-closed compute

Without a `READY` session, `src/index.ts` installs server settings that answer:

| Request                                        | Response                  |
| ---------------------------------------------- | ------------------------- |
| `api/contents`                                 | Empty read-only directory |
| `api/kernels`, `api/sessions`, `api/terminals` | `[]`                      |
| `api/kernelspecs`                              | No specifications         |
| anything else                                  | `503`                     |

Terminals use `NoopManager` with `terminalsAvailable` `false`. `tests/distribution.mjs` fails if a Pyodide, xeus
or JavaScript-kernel asset appears in `dist/`.
