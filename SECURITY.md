# Security Policy

## Supported Versions

Nothing is published; fixes land on `main` and deployments take them by rebuilding `dist/`. Report against
current `main`.

## Reporting a Vulnerability

Use the repository's **Security** tab, **Report a vulnerability**; never a public issue, pull request or
discussion. Include what an attacker can reach, reproduction steps, the browser and the commit. We acknowledge
the report and state whether we reproduced it before publishing a fix.

## Scope

This repository is the browser client. cs-plane authenticates every request, finishes sign-in and decides who
may reach a session; findings about those decisions belong to
[cs-plane](https://github.com/cyber-shuttle/cs-plane). Properties this client guarantees (mechanisms in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

| Property                                                                                                                                         | Code                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Sign-in tokens live only in per-tab `sessionStorage`, never `localStorage`; session grants stay in memory                                        | `src/AuthClient.ts`, `src/index.ts`   |
| cs-plane calls are pinned to the configured origin; the ID token never enters a URL, log or error; the SSH WebSocket carries it as a subprotocol | `src/PlaneClient.ts`, `src/ssh.ts`    |
| A session's Jupyter URI must be `sessions/<id>/jupyter/` under the configured cs-plane API URL                                                   | `src/PlaneClient.ts`                  |
| Responses are validated; a missing or mistyped field fails, and grants and tokens also refuse unknown keys                                       | `src/PlaneClient.ts`, `src/Common.ts` |
| No kernels, terminals or contents without a `READY` session                                                                                      | `src/index.ts`                        |

Attacks that presuppose the signed-in account's tokens or control of the configured cs-plane are out of scope.
