# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.1] - 2026-09-30

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

## [0.1.0] - 2026-09-07

### Added

- Static remote-only JupyterLite site and JupyterLab extension: the file browser, kernels and terminals run
  inside a Slurm allocation, with no in-browser kernel and no local notebook server.
- Launcher **Runtimes** section: submit an allocation, watch its state and startup log, connect to it, stop it
  and delete it.
- Microsoft device-code sign-in brokered by cs-control, with the returned credentials kept in per-tab
  `sessionStorage`.
- SSH host list with add, test and remove, and an xterm.js console for a host's interactive login prompts.
- An action refused because its host wants an interactive login now opens that login and retries once (#7).
- CI over the unit tests and a Chromium end-to-end run of the pipeline (#5), extended to the built `dist/`
  contract (#9).
- Architecture, deployment and contributing documentation, a security policy, issue and pull request
  templates, and the full Apache 2.0 license text in place of the short notice (#12).

### Changed

- **Run again** relaunches the runtime on its own card through cs-control, rather than opening a create form
  seeded from the finished one and producing a second card for the same work (#6).
- A card reads as starting from the click until the relaunch request answers, and follows that answer instead
  of waiting for the next poll (#7).
- The allocation form's floor is 2 cores and 4096 MB, matching what cs-control accepts (#5).
- The panel republishes runtimes only when cs-control reports the list changed (#9).
- The device-code sign-in prompt is a native `<dialog>` (#9).

### Removed

- Browser-side workspace-folder validation, which had drifted from the rules cs-control enforces (#9).

### Fixed

- The runtimes section was missing from every Launcher opened after the first (#6).
- A card being run again re-armed **Run again** a second after the click, and a failed relaunch lost its
  reason to the next poll (#7).
- 23 defects found by an adversarial review, each covered by a regression test (#9).
- The Launcher header and the runtime card category read "Cybershuttle", and the discovery interface read
  "SLURM" (#11).
- A control API or WebSocket URL on the IPv6 loopback host, such as `http://[::1]:8045/api/v1`, was rejected
  as insecure: the accepted loopback hosts held `::1`, while a URL reports that hostname as `[::1]` (#13).

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cyber-shuttle/cs-jupyter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cyber-shuttle/cs-jupyter/releases/tag/v0.1.0
