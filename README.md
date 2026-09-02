# CyberShuttle Jupyter

[![CI](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/cyber-shuttle/cs-jupyter?color=blue)](LICENSE)

CyberShuttle Jupyter is a browser-based JupyterLab distribution, built with
[JupyterLite](https://github.com/jupyterlite/jupyterlite), that runs notebooks and terminals on a
high-performance computing (HPC) compute node rather than on the machine in front of you. You sign in, ask a
[cs-control](https://github.com/cyber-shuttle/cs-control) daemon for a [Slurm](https://slurm.schedmd.com/)
allocation, and the file browser, kernels and terminals talk directly to the Jupyter server running inside
that job.

No compute runs locally: there is no notebook server on your machine and no in-browser kernel. Until an
allocation is running (`READY`) the application fails closed rather than falling back to local compute.

## Status

Pre-release. Version 0.1.0 in both `package.json` and `pyproject.toml`, no tags cut and no published
artifact. The built `dist/` directory is the only deliverable, and its configuration and the API it speaks
can change without notice. [CHANGELOG.md](CHANGELOG.md) records what has landed so far.

## Requirements

- **cs-control running on your own machine.** It owns every API this client calls and listens on loopback
  only, so each user runs their own.
- **Microsoft Entra sign-in.** Device-code sign-in, brokered by cs-control, is the only authentication path;
  this client has no other login and never calls Microsoft directly.
- **[Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/).** A runtime's
  Jupyter origin must be a bare `*.devtunnels.ms` host. An allocation reached through any other tunnel or
  ingress is rejected.
- A current browser; the application ships no polyfills.

## Using it

Start `csctl serve` on your machine, then open the site. The Launcher's **Runtimes** section offers
**Sign in**, which shows a Microsoft device code to enter. **Add Runtime** submits a Slurm allocation, and its
card tracks the job's state. Open that card and choose **Connect** once it reads `READY`; notebooks and
terminals then run inside the job.

## Deploy

Build `dist/` and host it as static files over HTTPS, set `cybershuttleControlApiUrl` in the served
`jupyter-lite.json`, and tell users the origin to allow in their own cs-control.
[docs/DEPLOYING.md](docs/DEPLOYING.md) has the commands and configuration.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — credentials, trust boundaries, runtime lifecycle
- [docs/DEPLOYING.md](docs/DEPLOYING.md) — hosting and configuring a deployment
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, tests, and what CI enforces
- [SECURITY.md](SECURITY.md) — reporting a vulnerability

## Related projects

cs-control brokers sign-in, creates and tracks Slurm allocations, and issues the per-allocation access this
client connects with. It serves neither this application nor its runtime traffic. What this client does with
those routes is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the routes themselves are defined by
[cyber-shuttle/cs-control](https://github.com/cyber-shuttle/cs-control).

## Support

Bug reports and questions go to [GitHub issues](https://github.com/cyber-shuttle/cs-jupyter/issues).
Vulnerabilities go through [SECURITY.md](SECURITY.md) instead.

## License

Apache-2.0. See [LICENSE](LICENSE).
