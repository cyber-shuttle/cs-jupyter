# CyberShuttle Jupyter

[![CI](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/cyber-shuttle/cs-jupyter?color=blue)](LICENSE)

A static [JupyterLite](https://github.com/jupyterlite/jupyterlite) distribution whose file browser, kernels and
terminals run on a [Slurm](https://slurm.schedmd.com/) compute node. You sign in, ask
[cs-plane](https://github.com/cyber-shuttle/cs-plane) for a session, and JupyterLab talks to the Jupyter server
inside that job. Nothing computes locally: until a session is `READY` the application fails closed.

Pre-release 0.1.0.

## Requirements

| Requirement                                                                                              | Notes                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| cs-plane 0.2.0 or newer                                                                                  | Owns every API this client calls: sign-in, hosts, keys, sessions |
| CILogon account                                                                                          | Sole sign-in path                                                |
| [Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) account (Microsoft/GitHub) | Optional; gives each session a fallback route                    |
| A current browser                                                                                        | No polyfills ship                                                |

## Usage

1. **Sign in** on the CyberShuttle title row of the Launcher.
2. **Add Session** in the Launcher's **Sessions** section submits a Slurm job; its card shows host, account,
   state, resources and remaining walltime.
3. Open the card and choose **Connect** once it reads `READY`. The detail dialog shows usage and the status log.
4. **Run history** keeps every run, including runs whose card was deleted.

## Documentation

| File                                         | Contents                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| [docs/DEPLOYING.md](docs/DEPLOYING.md)       | Build, `cybershuttleControlApiUrl`, cs-plane origin   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | cs-plane routes, credentials, session lifecycle       |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Development setup, scripts, CI                        |
| [SECURITY.md](SECURITY.md)                   | Reporting a vulnerability, client security properties |
| [CHANGELOG.md](CHANGELOG.md)                 | Changes                                               |

Bugs and questions: [GitHub issues](https://github.com/cyber-shuttle/cs-jupyter/issues). License: Apache-2.0.
