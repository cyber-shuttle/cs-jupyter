# Changelog

All notable changes to CyberShuttle Jupyter are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Edit an SSH login: the paste form now serves both adding and correcting, and an edit opens prefilled with a
  command rebuilt from what is configured, so nothing has to be retyped. The alias is the entry being edited,
  so it is not offered for renaming.
- A walltime countdown on the runtime card, in the detail dialog, and in the JupyterLab status bar on a
  runtime's own page, each warning below ten minutes. Every surface ticks on a clock of its own, because a
  settled runtime is answered `304` and emits no state to re-render from.
- Live CPU, memory and GPU usage in the runtime detail dialog, drawn against what the allocation was given
  rather than against each series' own maximum, and read only while that dialog is open.
- Run History lists an allocation that is still going in its live state rather than leaving it out. A run is a
  generation, so the generation a card is on now is a run like any other — it simply has no outcome yet, and
  showing only the finished ones beside it made a previous run read as the live session.
- A run report for a finished allocation — how long it ran, its peak memory, and how much of the CPU and
  memory it was given it actually used — and a **Run history** dialog listing every run this account has
  finished, including runs whose card has since been deleted.

### Changed

- A run report no longer promises accounting that will never arrive. cs-control chases Slurm's accounting for
  ten minutes and then leaves the record alone, so a run older than that says the figures are unknown instead
  of saying they will appear.

- Stop now asks first. It cancels the Slurm job, which is as destructive as Delete, and was the one verb doing
  it without confirmation.
- Deleting a running runtime takes one click. cs-control stops first and refuses until the scheduler releases
  the job, so the intent is kept and finished on the poll that sees it released.

### Removed

- `previewRuntimeScript`, which posted to a route cs-control no longer serves and which nothing called.

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

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cyber-shuttle/cs-jupyter/releases/tag/v0.1.0
