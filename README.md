# CyberShuttle Jupyter

[![CI](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-shuttle/cs-jupyter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/cyber-shuttle/cs-jupyter?color=blue)](LICENSE)

**CyberShuttle Jupyter is JupyterLab in your browser, running on a compute node of your Slurm cluster.**

You sign in, ask for a compute node, and connect. Your notebooks, terminals and files then live on that node. Nothing
runs on your own machine, and there is nothing to install.

- **Notebooks on the cluster's hardware.** Kernels run inside your Slurm job, on the cores, memory and GPUs you asked
  for.
- **No batch scripts.** A form offers the Slurm accounts and partitions the cluster reports for your login.
- **No SSH tunnels.** The job connects out to CyberShuttle, so the cluster needs no open port.
- **Live usage and walltime.** Each session shows its CPU and memory use and the time it has left.
- **A record of every run.** Run History keeps each session that has ended.

<img src="docs/media/launcher.png" alt="The Launcher with one ready session and one waiting in the queue" width="800">

Pre-release 0.1.1.

## What you can do

### Bring your own cluster login

A compute host is your login on a cluster. You name the cluster, your user name there and a folder to work in. You
can store a keypair or a password for it. You can also store nothing and answer each login yourself. When the cluster
asks for more, such as a one-time code, a dialog asks you.

<img src="docs/media/04-compute-host-add.png" alt="Adding a compute host" width="720">

### Request a compute node from a form

**Add Session** logs in to the cluster and reads your Slurm accounts and partitions. You choose from them, then set
cores, memory, GPUs and walltime. **Create** submits the job. There is no batch script to write.

<img src="docs/media/07-add-session.png" alt="The Add Session form" width="720">

### Work in JupyterLab on the node

**Connect** opens JupyterLab on the compute node. The file browser shows the session's folder on the cluster.
Notebooks, consoles and terminals run inside the job. The status bar counts down the walltime.

<img src="docs/media/10-connected.png" alt="JupyterLab connected to a session" width="800">

### Watch the job

Each session shows its state, its resources and its remaining walltime. Opening a session adds its current CPU,
memory and GPU use. It also adds a log of each state the session has passed through. You can see a queued job start,
and you can spot an idle one.

<img src="docs/media/09-ready.png" alt="A ready session with its usage and status log" width="720">

### Stop a session and review it later

**Stop** cancels the Slurm job and releases the allocation. The session then moves to **Run History**. Run History
lists every run with its outcome, how long it ran and its status log.

<img src="docs/media/12-run-history.png" alt="Run History with one finished run opened" width="720">

## Getting started

You need:

- the address of a CyberShuttle Jupyter deployment;
- a [CILogon](https://www.cilogon.org/) sign-in, which most universities and research institutions provide;
- an account on a Slurm cluster that the deployment lists;
- a current browser.

The ARTISAN group runs a deployment at <https://jupyter.cybershuttle.org>. To run your own, see
[Setting up](docs/SETTING-UP.md).

1. Open the deployment and choose **Sign in**.
2. Open **Compute Hosts** and add your login on a cluster.
3. Choose **Add Session**, pick the compute host, and choose **Create**.
4. Wait for the session to read `READY`, then choose **Connect**.
5. Choose **Stop** when you are done.

The [user guide](docs/USING.md) walks through each step with screenshots.

## FAQ

1. **Does anything run in my browser?**

   No. The browser only draws JupyterLab. Without a connected session the file browser is empty, and no kernel or
   terminal starts.

2. **How does my browser reach the compute node?**

   Compute nodes accept no connections from outside the cluster. Each job therefore runs
   [Linkspan](https://github.com/cyber-shuttle/linkspan), which connects out to the CyberShuttle API. Your browser
   talks to the CyberShuttle API, and the API relays to the job.

3. **Where is my credential kept?**

   The CyberShuttle API stores it for your account only. Your browser sends a private key once, when you save the
   credential, and does not keep it. You can also store nothing and answer each login yourself.

4. **What happens when the walltime runs out?**

   Slurm ends the job, and its kernels and terminals end with it. Every countdown turns to a warning in the last ten
   minutes. A connected page returns to the Launcher and shows the run's report.

5. **Can I start an ended session again?**

   No. Choose **Add Session** to submit a new job.

6. **Why am I asked to sign in again in a new tab?**

   Your sign-in is kept per tab. A new tab starts without it.

## Learn more

| Document                                     | Covers                                                                |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [docs/USING.md](docs/USING.md)               | Compute hosts, sessions, connecting and Run History, with screenshots |
| [docs/SETTING-UP.md](docs/SETTING-UP.md)     | The commands that bring up the CyberShuttle API and this site         |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | API routes, sign-in, the session lifecycle and fail-closed compute    |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Development setup, scripts and CI                                     |
| [SECURITY.md](SECURITY.md)                   | Reporting a vulnerability and the client's security properties        |
| [CHANGELOG.md](CHANGELOG.md)                 | What changed in each release                                          |

## Getting help

Search the [issue tracker](https://github.com/cyber-shuttle/cs-jupyter/issues) before opening an issue. Security
problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Acknowledgments

Developed by the [ARTISAN research group](https://gt-artisan.github.io/) at Georgia Tech. Built on
[JupyterLite](https://github.com/jupyterlite/jupyterlite), [JupyterLab](https://github.com/jupyterlab/jupyterlab),
[Linkspan](https://github.com/cyber-shuttle/linkspan) and [Slurm](https://slurm.schedmd.com/).

## License

[Apache-2.0](LICENSE)
