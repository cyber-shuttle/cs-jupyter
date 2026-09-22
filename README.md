# CyberShuttle Jupyter

[![CI](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/cyber-shuttle/cs-jupyter?color=blue)](LICENSE)

CyberShuttle Jupyter is a browser-based JupyterLab distribution, built with
[JupyterLite](https://github.com/jupyterlite/jupyterlite), that runs notebooks and terminals on a
high-performance computing (HPC) compute node rather than on the machine in front of you. You sign in, ask
[cs-plane](https://github.com/cyber-shuttle/cs-plane) for a [Slurm](https://slurm.schedmd.com/) session, and
the file browser, kernels and terminals talk directly to the Jupyter server running inside
that job.

No compute runs locally: there is no notebook server on your machine and no in-browser kernel. Until a
session is running (`READY`) the application fails closed rather than falling back to local compute.

## Status

Pre-release. Version 0.1.0 in both `package.json` and `pyproject.toml`, with no published
artifact. The built `dist/` directory is the only deliverable, and its configuration and the API it speaks
can change without notice. [CHANGELOG.md](CHANGELOG.md) records what has landed so far.

## Requirements

- **A cs-plane deployment.** cs-plane owns every API this client calls: it signs you in through Custos, holds
  your credentials, SSH hosts and session records, and submits the Linkspan job that runs each session.
- **CILogon sign-in.** An authorization-code flow with PKCE, finished by cs-plane, is the only
  authentication path; this client has no other login.
- **A linked Dev Tunnels account.** Sessions run over your own [Microsoft or GitHub Dev
  Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) account, linked once from the
  account menu's **Dev Tunnels** dialog. A session's
  Jupyter origin must be a `devtunnels.ms` host with at least two labels ahead of it, as a tunnel port's
  is. A session reached through any other tunnel or ingress is rejected.
- A current browser; the application ships no polyfills.

## Using it

Open the site. **Sign in** is on the CyberShuttle title row and
sends you to CILogon. The Launcher's **Sessions** section offers **Add Session**, which
submits a Slurm job and creates a session, and its card tracks the job's state: host, account, state, resources, and a remaining
walltime countdown. Open that card and choose **Connect** once it reads `READY`; notebooks and terminals then
run inside the job. What the session is using and its status log are in the detail dialog. Once a session ends
that moves to **Run history**, which keeps every run of every card, including runs whose card has since been
deleted.

## Deploy

Build `dist/` and host it as static files over HTTPS, set `cybershuttleControlApiUrl` in the served
`jupyter-lite.json`, and tell users the origin to allow in their own cs-plane.
[docs/DEPLOYING.md](docs/DEPLOYING.md) has the commands and configuration.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — credentials, trust boundaries, session lifecycle
- [docs/DEPLOYING.md](docs/DEPLOYING.md) — hosting and configuring a deployment
- [CONTRIBUTING.md](CONTRIBUTING.md) — development setup, tests, and what CI enforces
- [SECURITY.md](SECURITY.md) — reporting a vulnerability

## Related projects

cs-plane brokers sign-in, creates and tracks Slurm sessions, and issues the per-session access this
client connects with. It serves neither this application nor its session traffic. What this client does with
those routes is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the routes themselves are defined by
[cyber-shuttle/cs-plane](https://github.com/cyber-shuttle/cs-plane).

## Support

Bug reports and questions go to [GitHub issues](https://github.com/cyber-shuttle/cs-jupyter/issues).
Vulnerabilities go through [SECURITY.md](SECURITY.md) instead.

## License

Apache-2.0. See [LICENSE](LICENSE).
