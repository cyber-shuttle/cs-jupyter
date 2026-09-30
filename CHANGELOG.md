# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Remote-only JupyterLite site and federated extension: file browser, kernels and terminals run on a Slurm
  compute node through cs-plane's Jupyter proxy; no in-browser kernel.
- Launcher **Sessions** section: a wizard (SSH host, partition, cores, memory, GPU, walltime, Slurm account,
  transport) to submit a session; connect, start, stop and delete. Sessions, the detail dialog and the status bar
  show a walltime countdown; the detail dialog plots CPU, memory and GPU usage.
- **Run History** of every run, including runs of deleted sessions, with duration, peak memory and CPU and
  memory efficiency, filterable by platform: JupyterLab or VS Code.
- CILogon sign-in with PKCE, brokered by cs-plane.
- **SSH Hosts**: add, edit, check and delete SSH hosts, with an xterm.js console for SSH authentication.
  **SSH Keys**: upload, list and delete SSH keys an SSH host can be assigned.
- **Dev Tunnels**: connect or disconnect a Dev Tunnels account through a Microsoft or GitHub device-code flow.
- Strict validation of every cs-plane response.

### Changed

- cs-plane 0.4.0 serves run history at `GET runs` and a session's usage at `GET sessions/{id}/usage`, which the
  client now reads.
- Terminology follows the CyberShuttle contract; breaking wire and configuration renames:
  - Setting `cybershuttleControlApiUrl` is now `cybershuttlePlaneApiUrl`.
  - Transport value `websocket` is now `link`, labelled Link.
  - Session field `launcher` (`cs-plane`/`client`) is now `platform` (`jupyterlab`/`vscode`); runs carry `platform` too.
  - Dev Tunnels account routes moved from `tunnel*` to `devtunnels*`; error `tunnel_link_required` is now
    `devtunnels_account_required`.
  - SSH host entries, health, Slurm discovery, sessions and runs name the SSH host `alias` (was `name`, `host`, `sshHost`).
  - Dev Tunnels account fields `linked`/`linkedAt` are now `connected`/`connectedAt`; a completed poll reports
    status `connected`.
- A Dev Tunnel session refused for lack of a Dev Tunnels account shows cs-plane's message.
- Listed session resources need only be positive integers, not meet the create form's minimums.
- Slurm discovery refused again after SSH authentication reports cs-plane's message alone.

### Fixed

- Adding a session and validating its Slurm script answer an SSH authentication challenge and retry once.
- A failed sign-in callback is reported, not silently dropped.
- The Launcher no longer reads usage for queued sessions or run history every second.
- A session page refused by Jupyter reloads for fresh access, and reports a second refusal before Jupyter next
  succeeds instead of looping.

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/commits/main
