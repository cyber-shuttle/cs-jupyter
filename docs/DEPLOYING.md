# Deploying

A deployment is the built `dist/` served as static files over HTTPS, plus one configuration key naming its
CyberShuttle API. The CyberShuttle API is deployed separately, for example by
[cs-infra](https://github.com/cyber-shuttle/cs-infra); the CILogon client is configured there. Any path works:
the build uses relative URLs (`base_url` is empty in `jupyter_lite_config.json`).

## 1. Build

Requires the tools in [CONTRIBUTING.md](../CONTRIBUTING.md#setup), without Chromium.

```bash
bun install --frozen-lockfile
uv sync --frozen
bun run build   # deletes and rewrites dist/
```

## 2. Set `cybershuttlePlaneApiUrl`

In the `jupyter-config-data` object of the served `dist/jupyter-lite.json`:

```json
"cybershuttlePlaneApiUrl": "https://jupyterapi.example.edu/api/v1"
```

| Rule                                                             | Reason                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The CyberShuttle API's `AIRAVATA_PUBLIC_URL` plus `/api/v1`      | App URIs are accepted only as `processes/<id>/proxy/<port>/` under this URL |
| Absolute HTTPS or loopback HTTP; no credentials, query, fragment | Otherwise rejected at startup                                               |
| Patched after every build                                        | Ships empty; `tests/distribution.mjs` fails if a value is baked in          |

## 3. Configure the CyberShuttle API

| Setting                         | Value                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `AIRAVATA_CORS_ALLOWED_ORIGINS` | This site's exact origin; the default `*` admits any                                        |
| CILogon client redirect URIs    | This site's URL                                                                             |
| A batch deployment per cluster  | Its run section asks Linkspan for Jupyter, per the CyberShuttle API's `docs/interactive.md` |

## 4. Verify

Open the site, **Sign in** through CILogon, and confirm the account's sessions are listed. File browser, kernels
and terminals stay empty until a `READY` session is selected.
