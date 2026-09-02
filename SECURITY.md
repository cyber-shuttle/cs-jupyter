# Security Policy

## Supported Versions

Nothing is tagged or published yet. Fixes land on `main`, and a deployment takes them by rebuilding and
redeploying `dist/`. Report against current `main`.

## Reporting a Vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Please do not use a public issue, pull request or discussion for a security problem.

Include what an attacker can reach, the steps to reproduce it, the browser you reproduced it in, and the
commit you were on. We will acknowledge the report and say whether we can reproduce it before any fix is
published.

## Scope

This repository is the browser client. It authenticates nothing itself: cs-control validates every request,
brokers Microsoft device-code sign-in and decides who may reach an allocation, so a finding about those
decisions belongs to that project rather than here.

The invariants this client is responsible for; the mechanisms behind them are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- Credentials stay in per-tab `sessionStorage` — never `localStorage`, a URL, a log or an error
  (`src/AuthClient.ts`, `src/runtime-access.ts`).
- Every control call is pinned to the configured origin, and tokens travel as WebSocket subprotocols rather
  than in a URL (`src/ControlClient.ts`, `src/OAuthWebSocket.ts`).
- A runtime's Jupyter origin must be a bare `*.devtunnels.ms` host (`src/runtime-access.ts`).
- Responses are validated before use (`src/ControlClient.ts`, `src/Common.ts`).
- Compute is fail-closed: no kernels, terminals or contents without a valid `READY` generation
  (`src/index.ts`).

A report that assumes the attacker already holds the signed-in account's tokens, or already controls the
configured cs-control deployment, describes these boundaries rather than a way through them.
