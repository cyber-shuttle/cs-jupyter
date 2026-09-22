# Deploying

A deployment is the built `dist/` directory served as static files, plus one configuration key naming the
cs-plane it talks to. cs-plane is deployed on its own, for example by
[cs-infra](https://github.com/cyber-shuttle/cs-infra).

## Before you start

- Somewhere to serve static files over HTTPS. Any path works; the build uses relative URLs
  (`base_url` is empty in `jupyter_lite_config.json`).
- A running [cs-plane](https://github.com/cyber-shuttle/cs-plane) reachable over HTTPS. The CILogon client and
  the Custos URL are configured there rather than here.
- cs-plane must be able to hand out `*.devtunnels.ms` Jupyter origins for the sessions it creates. This
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
"cybershuttleControlApiUrl": "https://jupyterapi.example.edu/api/v1"
```

That is where your cs-plane serves its API. The value must be an absolute URL with no credentials, query or fragment, using HTTPS or loopback HTTP. Relative and implicit
same-origin values are rejected at startup.

The key ships empty on purpose — the build is deployment-neutral and `tests/distribution.mjs` fails if a
control endpoint is baked into it — so this edit is a deployment step, and `bun run build` removes `dist/`
and rewrites the file. Patch the served copy after each build.

## 3. Allow this site's origin on cs-plane

The browser calls cs-plane from this site's origin, so cs-plane has to be started with that origin in
`--allowed-origin`. The flag takes an exact origin (scheme, host and port, no path), is repeatable, requires at
least one entry and rejects `*`. Without a matching entry the browser blocks sign-in and every control request:

```bash
cs serve ... --allowed-origin https://jupyter.example.edu
```

## 4. Verify

With cs-plane running, open the site. The title row shows **Sign in**; completing CILogon sign-in
lists the sessions cs-plane holds for that account. Until a `READY` session
is selected the file browser, kernels and terminals stay empty by design — see
[ARCHITECTURE.md](ARCHITECTURE.md).
