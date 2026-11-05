# Setting up

This guide starts CyberShuttle Jupyter on one machine. Run the commands in order, in one shell.
[On a server](#on-a-server) lists the values that change for a deployment.

## Services

| Service              | Purpose                                                          | Address                 |
| -------------------- | ---------------------------------------------------------------- | ----------------------- |
| PostgreSQL           | Stores the CyberShuttle API's records                            | `localhost:15432`       |
| The CyberShuttle API | Signs users in, logs in to clusters, submits and relays sessions | `http://localhost:9095` |
| CyberShuttle Jupyter | The static site built from this repository                       | `http://localhost:8000` |

The CyberShuttle API is the Go server in the [Airavata](https://github.com/apache/airavata) repository. It is on the
`interactive` branch of `yasithdev/airavata` until
[apache/airavata#743](https://github.com/apache/airavata/pull/743) merges.

## Requirements

Tools. Each command prints a version.

```bash
git --version
go version          # 1.25 or newer
docker compose version
bun --version
uv --version
python3 --version   # 3.11 or newer
jq --version
openssl version
```

A CILogon client. Register it at <https://cilogon.org/oauth2/register>. CILogon reviews a client before it works.

| Client setting | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Callback URL   | `http://localhost:8000/lab/index.html`                                 |
| Scopes         | `openid`, `email`, `profile`, `org.cilogon.userinfo`, `offline_access` |

A Slurm cluster.

| Connection                 | Used for                             |
| -------------------------- | ------------------------------------ |
| API to login node, by SSH  | Logins and job submission            |
| Compute node to API, HTTPS | The job's connection back to the API |

A compute node cannot reach `localhost` on your machine. With the local addresses in this guide, sign-in and compute
hosts work. Sessions do not reach `READY`. To run sessions, use an API address that the compute nodes can reach.

## 1. Get the code

Clone both repositories into the same folder. The site's build reads the API description from the `airavata`
checkout.

```bash
git clone --branch interactive https://github.com/yasithdev/airavata.git
git clone https://github.com/cyber-shuttle/cs-jupyter.git
```

## 2. Start the database

```bash
docker compose -f airavata/dev-tools/compose/compose.yml up -d --wait postgres
```

## 3. Start the CyberShuttle API

Build the server.

```bash
cd airavata
go build -o bin/airavata-server ./cmd/airavata-server
```

Set its configuration. Replace the two CILogon values with your client's.

```bash
export CILOGON_CLIENT_ID='cilogon:/client_id/<your client id>'
export CILOGON_CLIENT_SECRET='<your client secret>'
export AIRAVATA_PUBLIC_URL=http://localhost:9095
export AIRAVATA_CORS_ALLOWED_ORIGINS=http://localhost:8000
export AIRAVATA_ROOT_ACCOUNT_TOKEN=$(openssl rand -hex 32)
```

| Variable                        | Meaning                                          |
| ------------------------------- | ------------------------------------------------ |
| `AIRAVATA_PUBLIC_URL`           | The API's address, as browsers and jobs open it  |
| `AIRAVATA_CORS_ALLOWED_ORIGINS` | The site's address                               |
| `AIRAVATA_ROOT_ACCOUNT_TOKEN`   | The administrator's token. Steps 4 and 5 send it |

Start the server in the background. Its log goes to `airavata/airavata.log`.

```bash
./bin/airavata-server > airavata.log 2>&1 &
cd ..
```

Check that it answers.

```bash
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://localhost:9095/health
```

Expected reply: `{"status":"UP"}`.

## 4. Register a cluster

Users choose from the clusters that the administrator registers. Replace the name and the login host with your
cluster's.

```bash
curl http://localhost:9095/api/v1/slurm-clusters \
  -H "Authorization: Bearer $AIRAVATA_ROOT_ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"clusterName": "hpc-a", "headnodeHost": "login.hpc-a.example.edu", "headnodePort": 22}'
```

The reply is the stored cluster. Copy its `slurmClusterId` into a variable. Step 5 uses it.

```bash
CLUSTER_ID='<slurmClusterId from the reply>'
```

## 5. Register the Jupyter application

Create the application.

```bash
curl http://localhost:9095/api/v1/application-templates \
  -H "Authorization: Bearer $AIRAVATA_ROOT_ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"templateName": "Jupyter"}'
```

The reply is the stored application. Copy its `templateId` into a variable.

```bash
TEMPLATE_ID='<templateId from the reply>'
```

Next, write the commands that each job runs to the file `jupyter-run.sh`. The first command asks
[Linkspan](https://github.com/cyber-shuttle/linkspan) to start a Jupyter server. The second keeps the job running.
The job sets the `CS_` variables.

```bash
cat > jupyter-run.sh <<'RUN'
curl -fsS -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 -H 'Content-Type: application/json' -d @- \
  "http://127.0.0.1:$CS_CONTROL_PORT/api/v1/jupyter/sessions" <<EOF
{"addr": "127.0.0.1:$CS_APP_PORT", "token": "$CS_APP_TOKEN", "root_dir": "$PWD"}
EOF
sleep infinity
RUN
```

Then write the request body to the file `deployment.json`. It joins the application, the cluster and the commands.
`jq` encodes the commands as a JSON string. The allocation is a placeholder. Each session sets its own.

```bash
jq -n --arg template "$TEMPLATE_ID" --arg cluster "$CLUSTER_ID" --rawfile run jupyter-run.sh \
  '{templateId: $template, slurmClusterId: $cluster, slurmRunSection: $run,
    defaultBatchJobConfig: {wallTimeMinutes: 60, allocation: "default", cpus: 2, mem: "4G"}}' \
  > deployment.json
cat deployment.json
```

Send the body.

```bash
curl http://localhost:9095/api/v1/slurm-deployments \
  -H "Authorization: Bearer $AIRAVATA_ROOT_ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @deployment.json
```

The reply is the stored record. It includes a `deploymentId`.

To add another cluster, repeat step 4. Then repeat the last two commands of this step.

## 6. Build the site

```bash
cd cs-jupyter
bun install --frozen-lockfile
uv sync --frozen
bun run build
```

The build writes the site to `dist/`.

## 7. Set the API address in the site

This command sets the address in `dist/jupyter-lite.json`.

```bash
perl -pi -e 's#"cybershuttlePlaneApiUrl": ""#"cybershuttlePlaneApiUrl": "http://localhost:9095/api/v1"#' dist/jupyter-lite.json
grep cybershuttlePlaneApiUrl dist/jupyter-lite.json
```

Expected output: `"cybershuttlePlaneApiUrl": "http://localhost:9095/api/v1",`

Each `bun run build` empties the address. Run this step after every build.

## 8. Serve the site

```bash
python3 -m http.server 8000 --directory dist
```

The server runs in the foreground. Ctrl-C stops it.

## 9. Check

Run these in a second shell.

```bash
curl -H 'Origin: http://localhost:8000' http://localhost:9095/api/v1/auth/config
```

Expected reply: a JSON object that contains your CILogon client id.

```bash
curl http://localhost:9095/api/v1/slurm-clusters
```

Expected reply: a JSON list that contains the cluster from step 4.

Open <http://localhost:8000/lab/index.html> and choose **Sign in**. After the CILogon page, your account name appears
on the **CyberShuttle** row. **Compute Hosts** lists the cluster. Continue with [USING.md](USING.md).

## Stopping

Stop the site with Ctrl-C. Then run these in the same shell.

```bash
cd ..
pkill airavata-server
docker compose -f airavata/dev-tools/compose/compose.yml down
```

The database keeps its records in a Docker volume. Add `--volumes` to the last command to delete them.

## On a server

A deployment runs the same services with these values.

| Setting                         | Local value                            | On a server                                            |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `AIRAVATA_PUBLIC_URL`           | `http://localhost:9095`                | The API's HTTPS address. Compute nodes must reach it.  |
| `AIRAVATA_CORS_ALLOWED_ORIGINS` | `http://localhost:8000`                | The site's HTTPS address. The default `*` allows any.  |
| `cybershuttlePlaneApiUrl`       | `http://localhost:9095/api/v1`         | `AIRAVATA_PUBLIC_URL` followed by `/api/v1`            |
| CILogon callback URL            | `http://localhost:8000/lab/index.html` | The site's HTTPS address followed by `/lab/index.html` |
| `AIRAVATA_ROOT_ACCOUNT_TOKEN`   | Generated in step 3                    | Generated once and stored on the server                |
| Database                        | The compose file                       | PostgreSQL with its own password and TLS               |
| Site                            | `python3 -m http.server`               | A static file server, such as nginx                    |

Rules for `cybershuttlePlaneApiUrl`:

- It uses HTTPS. HTTP is accepted only for loopback hosts.
- It has no credentials, query or fragment.
- The site does not start with an invalid value.

The site works from any path. The build uses relative URLs.

[cs-infra](https://github.com/cyber-shuttle/cs-infra) contains a deployment of both services on one VM. Its
`deployment-csvm/up.sh` performs these steps on a server. Its `register-cluster.sh` performs steps 4 and 5.

`INSTALL.md` in the `airavata` checkout documents the remaining API settings.
