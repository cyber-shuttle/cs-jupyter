# Changelog

All notable changes to CyberShuttle Jupyter are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There is no release process yet: see
[CONTRIBUTING.md](CONTRIBUTING.md#releases).

## [Unreleased]

### Added

- Static remote-only JupyterLite site and JupyterLab federated extension: the file browser, kernels and
  terminals run inside a Slurm allocation reached over the session's Dev Tunnel, with no in-browser kernel
  and no local notebook server.
- Launcher **Sessions** section: submit a session from a multi-step wizard (host, partition, cores, memory,
  GPU, walltime, Slurm account), watch its state and startup log, connect, run it again, stop it and delete
  it. A session card shows live CPU, memory and GPU usage plots against what its job spec requested, and a
  walltime countdown that also appears in the session detail dialog and the JupyterLab status bar.
- **Run history** dialog listing every run an account has made, live and finished, including runs whose card
  has since been deleted. A finished run's report gives how long it ran, its peak memory, and how much of the
  requested CPU and memory it used.
- Sign-in through CILogon's authorization-code flow with PKCE, brokered by cs-control; a single button, no
  provider choice. The ID token and refresh token live in per-tab `sessionStorage`.
- SSH host management: add, edit, test and remove a host, with an xterm.js console for interactive login
  prompts. Login keys, under the account menu, uploads a private key file under a name, lists stored keys
  with type and fingerprint, and deletes one; an SSH host can be assigned a stored key to sign in with.
- Dev Tunnels account linking, under the account menu: a Microsoft or GitHub device-code authorization links
  the account once, shown as a verification URI and one-time code with copy, open and cancel actions. Session
  creation reopens the dialog on `409 tunnel_link_required` and retries once linked.
- Every cs-control response is validated against a shared `Validator` vocabulary in `Common.ts`; an
  unrecognized, missing or mistyped field fails the same way.
- CI over the unit tests and a Chromium end-to-end run of the built site (`bun run test:browser`), plus a
  contract check against the built `dist/` (`bun run test:dist`).
- Architecture, deployment and contributing documentation, a security policy, issue and pull request
  templates, and the Apache 2.0 license.

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/commits/main
