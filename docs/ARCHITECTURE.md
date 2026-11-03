# Architecture

A static JupyterLite site plus one federated extension (`src/index.ts`). It talks to one origin, the CyberShuttle
API named by `cybershuttlePlaneApiUrl` ([DEPLOYING.md](DEPLOYING.md)), which also proxies each session's
Jupyter server. The CyberShuttle API does not serve this site, so every call is cross-origin. The routes are defined
by the spec `bun run types` generates into `src/api/airavata.ts` ([CONTRIBUTING.md](../CONTRIBUTING.md)); every call
goes through an openapi-fetch client typed by it, so a route or body the spec lacks does not compile.

## Routes and credentials

Paths are relative to `cybershuttlePlaneApiUrl` (`…/api/v1`).

| Route                                                                   | Use                                      | Credential                                        |
| ----------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `GET auth/config`, `POST auth/token`                                    | Sign-in                                  | none (`credentials: "omit"`, `redirect: "error"`) |
| `GET me`                                                                | Register the caller, first after sign-in | `Authorization: Bearer <ID token>`                |
| `GET slurm-cluster-configs/me`, `/shared-with-me`; `GET slurm-clusters` | Compute hosts; clusters to add one on    | Bearer                                            |
| `POST slurm-cluster-configs`; `DELETE slurm-cluster-configs/{id}`       | Add, delete a compute host               | Bearer                                            |
| `GET`, `POST ssh-credentials`; `DELETE ssh-credentials/{id}`            | Credentials                              | Bearer                                            |
| `GET ssh-interactive-auths`; `POST ssh-interactive-auths/{id}/response` | Logins waiting on the user, and answers  | Bearer                                            |
| `POST slurm-cluster-configs/{id}/discover-allocations`                  | Slurm accounts and partitions            | Bearer                                            |
| `GET slurm-deployments`, `GET application-templates`                    | Applications                             | Bearer                                            |
| `GET processes/me`, `GET processes/{id}`; `POST processes`              | Sessions and runs; create                | Bearer                                            |
| `POST processes/{id}/launch`, `/stop`                                   | Launch, stop                             | Bearer                                            |
| `GET processes/{id}/statuses`                                           | Status log                               | Bearer                                            |
| `GET processes/{id}/access`                                             | App URI and token once the link is up    | Bearer                                            |
| `processes/{id}/proxy/{port}/`                                          | Jupyter, and Linkspan's `api/v1/usage`   | Run token (`Authorization: token`, `?token=`)     |

- Requests go through `safePlaneFetch`: same origin as the configured URL, `credentials: "omit"`,
  `redirect: "error"`, `cache: "no-store"`; no cookies or XSRF header. A `401` drops the ID token, and the next
  poll asks for sign-in.
- Errors are `{"status", "error", "message"}`. `access` answers `409` until the link is up.
- Responses are the spec's types as openapi-fetch returns them; the client does not re-validate them.

## Sign-in

Clicking **Sign in** is the only trigger. The client reads the authorization endpoint from `auth/config`,
stores a PKCE verifier, `state` and return URL under `sessionStorage` key `cybershuttle.oauth.pkce.v1`, and
navigates to CILogon. On return, the next load posts `code` and the verifier to `auth/token`
(the CyberShuttle API holds the client secret) and restores the URL. Tokens live under `cybershuttle.oauth.v1`,
are refreshed through `auth/token` a minute before expiry, and are dropped once expired.

## Compute hosts

A compute host is a cluster config: cluster, login user, work root and a credential. A credential is a keypair,
a password, or nothing stored; a dialog asks for whatever a login needs beyond it. Only owned hosts delete;
shared ones carry a `permission`. An application is a `slurm-deployments` entry on the host's cluster, named by its template.

## Session lifecycle

A session is one `BATCH_JOB` process; its id is the process id.

| State                              | Client behaviour                                  |
| ---------------------------------- | ------------------------------------------------- |
| `CREATED`                          | Never launched. **Start** launches it             |
| `SUBMITTED`                        | Polled; status log shown                          |
| `READY`, `RUNNING`                 | Access fetched; **Connect** enabled once it is up |
| `COMPLETED`, `FAILED`, `CANCELLED` | A run in **Run History**                          |

Every second the Launcher reads `processes/me`, `statuses` for each session whose detail is open, and usage
for each linked one.

**Connect** reloads with `?session=<id>&workspace=<id>`; only the session ID enters the URL. On load
`src/index.ts` requests fresh access and points JupyterLab's contents, kernels, kernelspecs, sessions and terminals managers at it.
A Jupyter `401` or `403` reloads the page for fresh access; another before Jupyter next succeeds is reported. The
session page returns to the Launcher on sign-out, and with the run's report once the session ends or its walltime
runs out.

The JupyterLab layout is stored in the session's Jupyter root at `.cybershuttle/workspaces/<id>.json`, replacing
JupyterLite's browser-local workspace. Nothing from this repository runs on the compute node.

## Countdown and usage

- Deadline = the job's `BEGIN` status + `wallTimeMinutes`, ticked locally each second.
- The status-bar countdown reads the Launcher panel, which lives as long as the page.
- Every surface warns below ten minutes.
- Usage is Linkspan's current report, read through the proxy on the process's `controlPort` with the run token
  `access` gave; the Launcher keeps the last 20 per session.

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
