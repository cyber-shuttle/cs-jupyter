# Using CyberShuttle Jupyter

This guide follows one session from start to finish. You sign in, add your login on a cluster, request a compute
node, work on it, and stop it. Each step opens with a short recording of the whole step. The numbered list beneath
it names each click.

The recordings use a cluster named `hpc-a` and a user named `researcher`. Your deployment lists its own clusters.

| Step                                                                   | You do it                |
| ---------------------------------------------------------------------- | ------------------------ |
| [1. Sign in](#1-sign-in)                                               | Once per browser tab     |
| [2. Add a credential](#2-add-a-credential)                             | Once, and it is optional |
| [3. Add a compute host](#3-add-a-compute-host)                         | Once per cluster         |
| [4. Add a session](#4-add-a-session)                                   | Each time you want one   |
| [5. Connect](#5-connect)                                               | Once the job is running  |
| [6. Stop the session and review it](#6-stop-the-session-and-review-it) | When you are done        |

## Terms

| Term         | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| Compute host | Your login on one cluster: the cluster, your user name, a work root, a credential  |
| Credential   | A keypair or a password that CyberShuttle uses to log in to a compute host for you |
| Work root    | A folder on the cluster. Each session gets its own folder beneath it               |
| Session      | One Slurm job that runs a Jupyter server for you                                   |
| Run          | A session that has ended                                                           |

## 1. Sign in

<img src="media/guide-sign-in.webp" alt="Recording: signing in from the welcome dialog" width="800">

1. Open the address of your deployment. A welcome dialog appears.
2. Choose **Sign in**.
3. Pick your institution on the CILogon page and log in there. The recording skips this page.

The browser returns to CyberShuttle Jupyter. Your account name now shows on the **CyberShuttle** row.

Your sign-in belongs to this browser tab. A new tab asks you to sign in again.

## 2. Add a credential

A credential lets CyberShuttle log in to a cluster for you. This step is optional. Without a credential, a dialog
asks you for your password at each login.

<img src="media/guide-credential.webp" alt="Recording: adding a keypair under Credentials" width="800">

1. Choose your account name on the **CyberShuttle** row.
2. Choose **Credentials**.
3. Choose **Add credential**.
4. Pick a **Kind**, and fill in its fields.
5. Choose **Save credential**.

| Kind     | Field                 | What to enter                                     |
| -------- | --------------------- | ------------------------------------------------- |
| Keypair  | Name                  | A label you will recognise, such as `laptop-key`  |
| Keypair  | Public key            | The contents of the `.pub` file                   |
| Keypair  | Private key           | The private key file, such as `~/.ssh/id_ed25519` |
| Keypair  | Passphrase (optional) | The key's passphrase, if it has one               |
| Password | Name                  | A label you will recognise                        |
| Password | Password              | Your password on the cluster                      |

The cluster must already accept the key. Add the public key to `~/.ssh/authorized_keys` on the cluster if it is not
there yet.

A credential cannot be edited. To change one, choose **Delete** on it and add it again.

## 3. Add a compute host

A compute host tells CyberShuttle how to log in to a cluster as you. You need one before you can add a session.

<img src="media/guide-compute-host.webp" alt="Recording: adding a compute host and opening its details" width="800">

1. Choose **Compute Hosts** on the **Sessions** row.
2. Choose **Add Compute Host**.
3. Fill in the four fields.
4. Choose **Save compute host**.

| Field      | What to enter                                                                |
| ---------- | ---------------------------------------------------------------------------- |
| Cluster    | One of the clusters your deployment lists                                    |
| Login user | Your user name on that cluster                                               |
| Work root  | A folder you can write to on the cluster, such as `/home/<you>/cybershuttle` |
| Credential | A credential from step 2, or **None, ask at each login**                     |

The compute host now appears in the list. Choose it to see its details.

A compute host marked **Owned** is yours, and you can delete it. A compute host marked **Shared** belongs to someone
else, and you can only use it.

## 4. Add a session

A session is a Slurm job with a Jupyter server inside it. You describe the job in a form.

<img src="media/guide-add-session.webp" alt="Recording: adding a session, answering a login question and submitting the job" width="800">

1. Choose the **Add Session** card under **Sessions**.
2. Pick a **Compute host**. CyberShuttle now logs in to the cluster and reads your Slurm accounts and partitions.
3. Answer the cluster's question if a dialog shows one, then choose **Log in**.
4. Fill in the rest of the form.
5. Choose **Create**.

The cluster may ask for a password or a one-time code during the login. The dialog in step 3 shows that question. It
does not appear when your credential is enough.

| Field              | What to enter                                                       |
| ------------------ | ------------------------------------------------------------------- |
| Application        | The application to run. It is chosen for you when there is only one |
| Resource type      | **CPU** or **GPU**. It shows only when the cluster offers both      |
| Slurm account      | The account the job is charged to                                   |
| Partition          | The partition the job runs in                                       |
| Cores              | At least 2                                                          |
| Memory (MB)        | At least 4096                                                       |
| Walltime (minutes) | How long the job may run. Slurm ends the job when this time is up   |
| GPU type, GPUs     | Shown for **GPU** only                                              |

**Create** submits the job to Slurm. The dialog then switches to the new session. The session starts in the state
`SUBMITTED`, which means the job is waiting in the Slurm queue.

You can close the dialog while you wait. The session stays on the Launcher as a card. Choose the card to open the
session again.

| State                              | Meaning                                         | What you can do         |
| ---------------------------------- | ----------------------------------------------- | ----------------------- |
| `CREATED`                          | The session is saved but was never submitted    | **Start** submits it    |
| `SUBMITTED`                        | The job is waiting in the queue                 | **Stop** cancels it     |
| `READY`, `RUNNING`                 | The job is running on a compute node            | **Connect** or **Stop** |
| `COMPLETED`, `FAILED`, `CANCELLED` | The job has ended, and the session is now a run | Open it in Run History  |

## 5. Connect

<img src="media/guide-connect.webp" alt="Recording: a session becoming ready, then connecting to it" width="800">

1. Wait for the state to read `READY`. The **Status** log adds a line each time the state changes.
2. Wait for the **Jupyter** line to read `ready`. The **Connect** button then appears.
3. Choose **Connect**.

While you wait, the dialog shows the time remaining and plots of the job's CPU and memory use. A GPU session adds a
GPU plot.

**Connect** reloads the page onto the session. JupyterLab now works on the compute node.

| Part of the page | What it shows                                                             |
| ---------------- | ------------------------------------------------------------------------- |
| File browser     | The session's folder on the cluster, beneath the compute host's work root |
| Notebook         | The kernels that the job offers. A notebook runs on the compute node      |
| Terminal         | A shell on the compute node. Find it under **Other** on the Launcher      |
| Session card     | The session you are connected to is marked **Current**                    |
| Status bar       | The walltime left. It turns to a warning colour in the last ten minutes   |

The arrow beside **Sessions** returns you to the list of sessions. Returning to the list does not stop the session.
To move to another session, open it and choose **Connect**.

Save your work before the walltime runs out. Slurm ends the job at that moment, and its kernels and terminals end
with it. The page then returns to the Launcher and shows the run's report.

## 6. Stop the session and review it

Stop a session when you are done. Stopping releases the allocation, so the job stops using your Slurm account.

<img src="media/guide-stop.webp" alt="Recording: stopping a session and opening its report in Run History" width="800">

1. Choose the arrow beside **Sessions** to return to the list.
2. Open the session.
3. Choose **Stop**, then confirm with **Stop**.
4. Choose **Run History** on the **Sessions** row.
5. Choose the run to open its report.

Stopping cancels the Slurm job. Anything unsaved in its kernels and terminals is lost. Files you saved stay on the
cluster.

Run History lists your running sessions first. Your ended runs follow, newest first. A report shows when the run
ended, its outcome, how long it ran and its status log. A failed run also shows the error.

Closing the tab or signing out does not stop a session. The job keeps running until you stop it or its walltime runs
out.

An ended session cannot be started again. Choose **Add Session** to submit a new job.

## Signing out

1. Choose your account name on the **CyberShuttle** row.
2. Choose **Sign out**.

Your sessions keep running on the cluster after you sign out.

## When something goes wrong

| You see                                                | What it means                                    | What to do                                                  |
| ------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| `Add a compute host before creating a session.`        | You have no compute host yet                     | Follow [step 3](#3-add-a-compute-host)                      |
| `No CPU or GPU Slurm partitions were discovered for …` | The cluster reported no partition for your login | Ask the cluster's support which partitions you may use      |
| A session stays `SUBMITTED`                            | The job is still waiting in the Slurm queue      | Wait, or stop it and ask for fewer resources                |
| The session is `READY` but **Jupyter** stays `pending` | The Jupyter server has not answered yet          | Wait. The first session on a cluster takes a few minutes    |
| The status log says the job `runs without a link`      | The job runs, but CyberShuttle cannot reach it   | Stop the session and report the log line to your deployment |
| `Session updates unavailable.`                         | The browser cannot reach the CyberShuttle API    | Check your network. The page keeps trying                   |
| `Sign in again to resume session updates.`             | Your sign-in has expired                         | Choose **Sign in**                                          |
