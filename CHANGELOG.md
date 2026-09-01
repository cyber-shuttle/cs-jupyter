# Changelog

All notable changes to CyberShuttle Jupyter are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

No version has been released: the repository carries no tags and publishes no package. `package.json` and
`pyproject.toml` both read `0.1.0`, and a deployment picks changes up by rebuilding and redeploying `dist/`.
Everything below is therefore unreleased.

## [Unreleased]

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
