# Deploying

A deployment is the built `dist/` served as static files over HTTPS, plus one configuration key naming its
cs-plane. cs-plane is deployed separately, for example by [cs-infra](https://github.com/cyber-shuttle/cs-infra);
the CILogon client and Custos URL are configured there. Any path works: the build uses relative URLs
(`base_url` is empty in `jupyter_lite_config.json`).

## 1. Build

Requires the tools in [CONTRIBUTING.md](../CONTRIBUTING.md#setup), without Chromium.

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run build   # deletes and rewrites dist/
```

## 2. Set `cybershuttleControlApiUrl`

In the `jupyter-config-data` object of the served `dist/jupyter-lite.json`:

```json
"cybershuttleControlApiUrl": "https://jupyterapi.example.edu/api/v1"
```

| Rule                                                             | Reason                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Equals cs-plane's `--public-url` plus `/api/v1`                  | Session Jupyter URIs are accepted only as `sessions/<id>/jupyter/` under it |
| Absolute HTTPS or loopback HTTP; no credentials, query, fragment | Otherwise rejected at startup                                               |
| Patched after every build                                        | Ships empty; `tests/distribution.mjs` fails if a value is baked in          |

## 3. Allow this site's origin on cs-plane

cs-plane must list the site's exact origin (scheme, host, port; no path) in `--allowed-origin`, which is
repeatable, requires one entry and rejects `*`. Otherwise the browser blocks sign-in and every control request.

```bash
cs serve ... --allowed-origin https://jupyter.example.edu
```

## 4. Verify

Open the site, **Sign in** through CILogon, and confirm the account's sessions are listed. File browser, kernels
and terminals stay empty until a `READY` session is selected.
