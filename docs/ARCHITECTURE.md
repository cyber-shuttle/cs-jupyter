# Architecture

A static JupyterLite site plus one federated extension (`src/index.ts`). It talks to one origin, the cs-plane
API named by `cybershuttlePlaneApiUrl` ([DEPLOYING.md](DEPLOYING.md)), which also proxies each session's
Jupyter server. cs-plane does not serve this site, so every call is cross-origin. The routes are defined by
[cs-plane](https://github.com/cyber-shuttle/cs-plane); this file records what the client relies on.

## Routes and credentials

Paths are relative to `cybershuttlePlaneApiUrl` (`…/api/v1`).

| Route                                                                                    | Use                             | Credential                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| `GET oauth/config`, `POST oauth/exchange`, `POST oauth/refresh`                          | Sign-in                         | none (`credentials: "omit"`, `redirect: "error"`) |
| `GET`, `POST sessions`; `POST sessions/validate`                                         | List (`ETag`/`304`), create     | `Authorization: Bearer <ID token>`                |
| `GET`, `DELETE sessions/{id}`; `POST sessions/{id}/start`, `/stop`                       | Status, start, stop, delete     | Bearer                                            |
| `GET sessions/{id}/usage`, `GET runs`                                                    | Usage samples, run history      | Bearer                                            |
| `GET sessions/{id}/access`                                                               | Run-bound Jupyter URI and token | Bearer                                            |
| `GET`, `POST hosts`; `PUT`, `DELETE hosts/{alias}`; `GET hosts/{alias}/health`, `/slurm` | SSH hosts, Slurm discovery      | Bearer                                            |
| `WS hosts/{alias}/ssh`                                                                   | SSH authentication              | ID token as the `bearer.` subprotocol             |
| `GET`, `POST keys/ssh`; `DELETE keys/ssh/{id}`                                           | SSH keys                        | Bearer                                            |
| `GET`, `DELETE devtunnels`; `POST devtunnels/authorizations`, `/{handle}/poll`           | Dev Tunnels account             | Bearer                                            |
| `sessions/{id}/jupyter/`                                                                 | Jupyter REST and WebSocket      | Jupyter token (`Authorization: token`, `?token=`) |

- cs-plane requests go through `safePlaneFetch`: same origin as the configured URL, `credentials: "omit"`,
  `redirect: "error"`, `cache: "no-store"`; no cookies or XSRF header. A `401` drops the ID token.
- The SSH socket offers `cybershuttle.v1` plus the bearer subprotocol and fails unless cs-plane selects
  `cybershuttle.v1`.
- Errors are `{"error": {"code", "message"}}`. The client acts on `ssh_authentication_required` (opens the
  SSH authentication console, retries once) and `session_access_unavailable` (`409` while a session leaves `READY`).
- Every response passes a `Validator` from `src/Common.ts`; an object validator fails on a missing or mistyped
  field and ignores unlisted ones; grant and token validators are strict.

## Sign-in

Clicking **Sign in** is the only trigger. The client reads the authorization endpoint from `oauth/config`,
stores a PKCE verifier, `state` and return URL under `sessionStorage` key `cybershuttle.oauth.pkce.v1`, and
navigates to CILogon. On return, the next load posts `code`, `state` and the verifier to `oauth/exchange`
(cs-plane holds the client secret) and restores the URL. Tokens live under `cybershuttle.oauth.v1`, are refreshed
through `oauth/refresh` a minute before expiry, and are dropped once expired.

A connected Dev Tunnels account is optional; it enables the Dev Tunnel transport a session may choose besides
the link transport. The client drives the device-code flow and shows the verification URI and code; cs-plane
keeps the credential.

## Session lifecycle

| State                              | Client behaviour                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SUBMITTING`, `QUEUED`, `STARTING` | Polled; startup log shown                                                                           |
| `READY`                            | Access fetched; **Connect** enabled                                                                 |
| `STOPPING`                         | Polled                                                                                              |
| `STOPPED`, `FAILED`                | Terminal. **Start** submits a new Slurm job for the same session, shown `SUBMITTING` until answered |

Every second the Launcher reads `sessions`, `sessions/{id}/usage` for each `STARTING` or `READY` session, and
`runs` when the list changed, **Run History** is open or a run's accounting is pending.

Once a session is `READY`, the Launcher requests its access once per run and records in memory only that Jupyter
is up. **Connect** reloads with `?session=<id>&workspace=<id>`; only the session ID enters the URL. On load
`src/index.ts` requests fresh access, requires its Jupyter URI to equal `sessions/<id>/jupyter/` under the
cs-plane API URL, and points JupyterLab's contents, kernels, kernelspecs, sessions and terminals managers at it.
A Jupyter `401` or `403` reloads the page for fresh access; another before Jupyter next succeeds is reported. The
session page returns to the Launcher on sign-out, and with the run's report once the session ends or its walltime
runs out.

The JupyterLab layout is stored in the session's home at `.cybershuttle/workspaces/<id>.json`, replacing
JupyterLite's browser-local workspace. Linkspan, launched by cs-plane, builds the Python environment and starts
Jupyter on the compute node; nothing from this repository runs there.

## Countdown and usage

- Deadline = `startedAt` + `resources.wallMinutes`, ticked locally each second, since a queued session's poll
  returns `304` for minutes.
- The status-bar countdown reads the Launcher panel, which lives as long as the page.
- Every surface warns below ten minutes.
- CPU usage is plotted against Slurm's granted cores when reported, else the requested cores.

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
