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
never start OAuth. If the in-memory credentials expire, polling suspends without
retrying and the Sign in action is enabled again. Each successful token response
supplies both the opaque Dev Tunnels access token and its signed Microsoft ID
token. Those credentials remain in Lite memory only; cs-control discards any returned
refresh token before responding. Device broker calls use `credentials: omit`,
reject redirects and malformed response bodies, and never place access or ID
tokens in URLs. Control HTTP requests send them as
`Authorization: Bearer <access-token>` and
`X-CyberShuttle-Identity: <ID-token>`; they do not use cookies, XSRF headers,
or a same-origin proxy. Interactive SSH authentication sends exactly three
WebSocket subprotocols:
`cybershuttle.v1`, `bearer.<base64url-utf8-access-token>`, and
`identity.<base64url-utf8-ID-token>`. Tokens are never put in a WebSocket URL
or storage, and the client fails closed unless the server negotiates exactly
`cybershuttle.v1`. cs-control does not serve the Lite application or runtime
traffic.

## Runtime flow

1. The native Launcher manages SSH hosts and allocations through the configured
   cross-origin cs-control API.
2. One authenticated read of `GET /api/v1/runtimes`, polled once a second,
   supplies the runtime state (`SUBMITTING`, `QUEUED`, `STARTING`, `READY`,
   `STOPPING`, `STOPPED`, `FAILED`) and the startup tails.
3. A `STOPPED` or `FAILED` allocation is gone. "Run again" opens the create
   form seeded from it rather than resuming a dead job.
4. Connect is available once the runtime state is `READY` and an access
   response has been fetched for it. Lite directly
   requests the separate owner-authenticated runtime-access response; no Dev
   Tunnel popup or cookie bootstrap is used.
5. Lite stores that exact generation-bound access response only in
   `sessionStorage`, reloads with the nonsecret runtime ID and generation in its
   static query, and configures Contents, Kernel, KernelSpec, Session, and
   Terminal managers directly against the Jupyter HTTPS/WSS Dev Tunnel URI.
   HTTP sends `Authorization: Bearer <capability>` with `credentials: omit`;
   WebSockets carry the capability in the CyberShuttle subprotocol.

The session cache intentionally keeps the capability across same-tab reloads so
an active runtime remains usable while cs-control is unavailable. It is never
written to localStorage, URLs, logs, errors, or runtime cards. Expired,
stale, malformed, and unrelated-origin entries are rejected.
There is no local kernel fallback; the Launcher and all compute managers remain
fail-closed until a valid READY generation is selected.

## Remote compute environment

Provision each compute host with uv and a site-approved Python 3.10 or newer:

```bash
UV="$HOME/.local/bin/uv"
JUPYTER_ENV="$HOME/.cybershuttle/jupyter-env"
PYTHON_VERSION=3.13 # Replace with a site-approved version >=3.10.
"$UV" venv --clear --python "$PYTHON_VERSION" "$JUPYTER_ENV"
"$UV" pip install --python "$JUPYTER_ENV/bin/python" \
  jupyter-server ipykernel jupyter-server-terminals
"$JUPYTER_ENV/bin/python" -c \
  'import ipykernel, jupyter_server, jupyter_server_terminals'
```

Do not add JupyterLab, a `cs-jupyterlab` wheel, conda, or standalone pip.
Recreating the environment must not copy or remove separately stored
credentials.

## Build and test

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run typecheck
bun run lint
bun run test
bun run build:lite
bun run test:dist
bun run test:browser
```
