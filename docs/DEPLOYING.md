# Deploying

A deployment is the built `dist/` directory served as static files, plus one configuration key. There is no
server-side component here, but cs-control is a per-user daemon: each user installs and runs `csctl` on their
own machine before they can sign in.

## Before you start

- Somewhere to serve static files over HTTPS. Any path works; the build uses relative URLs
  (`base_url` is empty in `jupyter_lite_config.json`).
- Each user runs [cs-control](https://github.com/cyber-shuttle/cs-control) (`csctl serve`) on their own
  machine; it listens on loopback only. They pass this site's origin as `--allowed-origin`, and the Microsoft
  Entra authority is configured there rather than here.
- cs-control must be able to hand out `*.devtunnels.ms` Jupyter origins for the allocations it creates. This
  client rejects anything else, and the rule is not configurable.

## 1. Build

Requires [Bun](https://bun.com/), [uv](https://docs.astral.sh/uv/) and Python 3.11 or newer.

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run build
```

`dist/` is the deployable site.

## 2. Configure the control endpoint

Set `cybershuttleControlApiUrl` in the `jupyter-config-data` object of the **served**
`dist/jupyter-lite.json`, including the API base path:

```json
"cybershuttleControlApiUrl": "http://127.0.0.1:8045/api/v1"
```

That is `csctl serve`'s default listen address; change it only if your users run it elsewhere. The value must
be an absolute URL with no credentials, query or fragment, using HTTPS or loopback HTTP. Relative and implicit
same-origin values are rejected at startup.

The key ships empty on purpose — the build is deployment-neutral and `tests/distribution.mjs` fails if a
control endpoint is baked into it — so this edit is a deployment step, and `bun run build` removes `dist/`
and rewrites the file. Patch the served copy after each build.

## 3. Tell users the origin to allow

The browser calls each user's cs-control from this site's origin, so their daemon has to be told that origin.
`--allowed-origin` takes an exact origin (scheme, host and port, no path), is repeatable, requires at least
one entry and rejects `*`. Without a matching entry the browser blocks sign-in and every control request. The
command they run:

```bash
csctl serve \
  --oauth-authority https://login.microsoftonline.com/<tenant>/ \
  --allowed-origin https://jupyter.example.edu
```

## 4. Verify

With `csctl serve` running, open the site. The Launcher shows a **Runtimes** section offering **Sign in**;
completing device-code sign-in lists the runtimes cs-control holds for that account. Until a `READY` runtime
is selected the file browser, kernels and terminals stay empty by design — see
[ARCHITECTURE.md](ARCHITECTURE.md).
