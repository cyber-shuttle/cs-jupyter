# Security Policy

## Supported Versions

Nothing is published; fixes land on `main` and deployments take them by rebuilding `dist/`. Report against
current `main`.

## Reporting a Vulnerability

Use the repository's **Security** tab, **Report a vulnerability**; never a public issue, pull request or
discussion. Include what an attacker can reach, reproduction steps, the browser and the commit. We acknowledge
the report and state whether we reproduced it before publishing a fix.

## Scope

This repository is the browser client. The CyberShuttle API authenticates every request and decides who
may reach a session; findings about those decisions belong to
[the CyberShuttle API](https://github.com/apache/airavata). Properties this client guarantees (mechanisms in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

| Property                                                                                                      | Code                                |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Sign-in tokens live only in per-tab `sessionStorage`, never `localStorage`; session grants stay in memory     | `src/AuthClient.ts`, `src/index.ts` |
| The CyberShuttle API calls are pinned to the configured origin; the API token never enters URLs, logs, errors | `src/PlaneClient.ts`                |
| A private key goes only in the `POST ssh-credentials` body                                                    | `src/SshKeys.ts`                    |
| Jupyter is reached only at `processes/<id>/jupyter/` under the configured CyberShuttle API URL                | `src/PlaneClient.ts`                |
| No kernels, terminals or contents without a running session                                                   | `src/index.ts`                      |

Attacks that presuppose the signed-in account's tokens or control of the configured CyberShuttle API are out of scope.
