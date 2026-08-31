# CyberShuttle Jupyter

CyberShuttle's static, remote-only JupyterLite distribution and native
federated extension. It owns the OAuth control client, Launcher allocation and
service UI, xterm transport, runtime selection, and direct remote Jupyter
service composition.

## Static workspace configuration

The Lite site is hosted independently from cs-control. One `PageConfig` option
configures a deployment:

```text
cybershuttleControlApiUrl=https://control.example.edu/api/v1
```

It must be an absolute URL; relative and implicit same-origin values are
rejected. The origin it names must be one cs-control allows for OAuth control
calls. Use HTTPS except for loopback development. Configure the tenant-specific
Microsoft authority only on cs-control; Lite has no authority, scope, native
client ID, SPA client, or MSAL configuration.

Only after the user clicks the Launcher's **Sign in** action, the browser asks
the configured cs-control endpoint to start and poll its memory-only Microsoft
device-code broker. Lite never calls Microsoft OAuth endpoints. It displays the
verification URI and one-time user code in an
accessible dialog with explicit copy, open, and cancel actions. No redirect
URI, SPA registration, popup authorization, or automatic interaction is used.
App restore, panel construction, cached direct-runtime restore, and polling
never start OAuth. Each successful token response supplies both the opaque Dev
Tunnels access token and its signed Microsoft ID token; cs-control discards any
returned refresh token before responding.

Those credentials live in per-tab `sessionStorage` under
`cybershuttle.oauth.v1`, so the reload that opens a runtime does not repeat the
device-code round trip. They are never written to `localStorage`, a URL, a log
or an error. When they expire, polling suspends without retrying and the Sign
in action is enabled again.

Every credential this app carries, and where it goes:

| Hop                | Route                                        | Credential                                                           |
| ------------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| Device sign-in     | `POST /oauth/device/start`, `/poll/{handle}` | none (`credentials: omit`, `redirect: "error"`)                      |
| Control API        | `/api/v1/*`                                  | `Authorization: Bearer <access>` and `X-CyberShuttle-Identity: <ID>` |
| SSH authentication | `WS /api/v1/ssh/{alias}/auth`                | the two tokens as `bearer.` and `identity.` subprotocols             |
| Jupyter            | the allocation's Dev Tunnel origin           | the generation-bound Jupyter token                                   |

The control API uses no cookies, XSRF header or same-origin proxy. The SSH
socket offers exactly `cybershuttle.v1` plus the two credential subprotocols
and fails closed unless the server negotiates `cybershuttle.v1`; tokens never
appear in a WebSocket URL. The routes and their trust boundaries are
cs-control's, and its [README](https://github.com/cyber-shuttle/cs-control) is
the canonical description of them. cs-control does not serve the Lite
application or runtime traffic.

## Runtime flow

1. The native Launcher manages SSH hosts and allocations through the configured
   cross-origin cs-control API.
2. One authenticated read of `GET /api/v1/runtimes`, polled once a second,
   supplies the runtime state (`SUBMITTING`, `QUEUED`, `STARTING`, `READY`,
   `STOPPING`, `STOPPED`, `FAILED`) and the startup tails.
3. A `STOPPED` or `FAILED` allocation is gone. "Run again" submits a new one
   under the same card and settings rather than resuming a dead job, and the
   card reads `SUBMITTING` from the click until that request answers, so it
   never offers a second run over one already in flight.
4. Connect is available once the runtime state is `READY` and an access
   response has been fetched for it. Lite directly
   requests the separate owner-authenticated runtime-access response; no Dev
   Tunnel popup or cookie bootstrap is used.
5. Lite stores that exact generation-bound access response only in
   `sessionStorage`, reloads with the nonsecret runtime ID and generation in its
   static query, and configures Contents, Kernel, KernelSpec, Session, and
   Terminal managers directly against the Jupyter HTTPS/WSS Dev Tunnel URI.
   Those managers use JupyterLab's own `ServerConnection` token handling:
   `Authorization: token <capability>` on REST and `?token=` on the Jupyter
   WebSocket URLs.

The session cache intentionally keeps the capability across same-tab reloads so
an active runtime remains usable while cs-control is unavailable. It is never
written to localStorage, the page URL, logs, errors, or runtime cards. An entry
for another runtime or generation, or one whose expiry has passed, is discarded
on read, and the Dev Tunnel URI it names must be a bare `*.devtunnels.ms`
origin. There is no local kernel fallback; the Launcher and all compute managers
remain fail-closed until a valid READY generation is selected.

## Remote compute environment

Nothing is provisioned by hand. cs-control installs uv and the Jupyter
environment on the compute host when it creates an allocation, and the
allocation builds it under `$HOME/.cybershuttle/jupyter-env`.

## Build and test

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run lint      # typecheck + prettier --check
bun run build     # clean + build:lib + build:lite
bun run test:all  # vitest + test:dist + test:browser
```
