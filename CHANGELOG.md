# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Remote-only JupyterLite site and federated extension: file browser, kernels and terminals run in a Slurm
  allocation through cs-plane's Jupyter proxy; no in-browser kernel.
- Launcher **Sessions** section: a wizard (host, partition, cores, memory, GPU, walltime, account, tunnel) to submit a
  session; connect, run again, stop and delete. Cards, the detail dialog and the status bar show a walltime
  countdown; the detail dialog plots CPU, memory and GPU usage.
- **Run history** of every run, including runs whose card was deleted, with duration, peak memory and CPU and
  memory efficiency, filterable by platform: JupyterLab or VS Code (CS Bridge).
- CILogon sign-in with PKCE, brokered by cs-plane.
- **SSH Hosts**: add, edit, check and remove hosts, with an xterm.js console for interactive login. **SSH Keys**:
  upload, list and remove private keys a host can be assigned.
- **Dev Tunnels** account linking through a Microsoft or GitHub device-code flow.
- Strict validation of every cs-plane response.

[Unreleased]: https://github.com/cyber-shuttle/cs-jupyter/commits/main
