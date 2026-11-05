# CyberShuttle Jupyter

[![CI](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/cyber-shuttle/cs-jupyter?color=blue)](LICENSE)

A static [JupyterLite](https://github.com/jupyterlite/jupyterlite) distribution whose file browser, kernels and
terminals run on a [Slurm](https://slurm.schedmd.com/) compute node. You sign in, ask the
CyberShuttle API for a session, and JupyterLab talks to the Jupyter server
inside that job. Nothing computes locally: until a session is `READY` the application fails closed.

Pre-release 0.1.1.

## Requirements

| Requirement          | Notes                            |
| -------------------- | -------------------------------- |
| The CyberShuttle API | Owns every API this client calls |
| CILogon account      | Sole sign-in path                |
| A current browser    | No polyfills ship                |

## Usage

1. **Sign in** on the CyberShuttle title row of the Launcher.
2. **Add Session** in the Launcher's **Sessions** section submits a Slurm job on a compute host, added under
   **Compute Hosts** with a key or password from **Credentials**, or none to answer each login; the session shows its
   compute host, application, Slurm account, state, resources and remaining walltime.
3. Open the session and choose **Connect** once it reads `READY`. The detail dialog shows usage and the status log.
4. **Run History** keeps every ended session.

## Documentation

| File                                         | Contents                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| [docs/DEPLOYING.md](docs/DEPLOYING.md)       | Build, `cybershuttlePlaneApiUrl`, API setup           |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | API routes, credentials, session lifecycle            |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Development setup, scripts, CI                        |
| [SECURITY.md](SECURITY.md)                   | Reporting a vulnerability, client security properties |
| [CHANGELOG.md](CHANGELOG.md)                 | Changes                                               |

Bugs and questions: [GitHub issues](https://github.com/cyber-shuttle/cs-jupyter/issues). License: Apache-2.0.
