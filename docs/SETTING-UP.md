# Setting up

This guide brings up a working CyberShuttle Jupyter from two checkouts. Run the blocks from top to bottom in one
shell. Each block uses the variables that the blocks before it set.

The first pass runs everything on one machine. [Deploying for real](#deploying-for-real) then lists what changes on a
server.

## What comes up

| Service              | What it does                                                     | Where it listens        |
| -------------------- | ---------------------------------------------------------------- | ----------------------- |
| PostgreSQL           | Holds the CyberShuttle API's records                             | `localhost:15432`       |
| The CyberShuttle API | Signs users in, logs in to clusters, submits and relays sessions | `http://localhost:9095` |
| CyberShuttle Jupyter | The static site in this repository                               | `http://localhost:8000` |

The CyberShuttle API is the Go server in the [Airavata](https://github.com/apache/airavata) repository. Until
[apache/airavata#743](https://github.com/apache/airavata/pull/743) merges, it lives on the `interactive` branch of
`yasithdev/airavata`.

## Before you start

Install these tools first. Each command prints a version when the tool is present.

```bash
git --version
go version          # 1.25 or newer
docker compose version
bun --version
uv --version
python3 --version   # 3.11 or newer
jq --version
```

You also need a CILogon client and a Slurm cluster. This guide cannot create them for you.

| You need                  | Details                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| A CILogon client          | Register one at <https://cilogon.org/oauth2/register>. CILogon reviews it before it becomes active. |
| Its callback URL          | `http://localhost:8000/lab/index.html`                                                              |
| Its scopes                | `openid`, `email`, `profile`, `org.cilogon.userinfo`, `offline_access`                              |
| A Slurm cluster           | The API must reach its login node over SSH.                                                         |
| A route back from the job | The cluster's compute nodes must reach the API's URL.                                               |

The last row decides whether sessions work. A job connects back to the API, so a compute node must be able to open
the API's URL. A compute node cannot open `localhost` on your machine. With the local values below you can therefore
sign in and add compute hosts, but a session never becomes `READY`. Set `API_URL` to an address the cluster can reach
when you want sessions to connect.

## 1. Choose the settings

```bash
export API_URL=http://localhost:9095     # where browsers and compute nodes reach the API
export SITE_URL=http://localhost:8000    # where browsers reach the site
export CILOGON_CLIENT_ID='cilogon:/client_id/<your client id>'
export CILOGON_CLIENT_SECRET='<your client secret>'
```

## 2. Get the code

Clone the two repositories side by side. The site's build reads the API's description from the checkout next to it.

```bash
git clone --branch interactive https://github.com/yasithdev/airavata.git
git clone https://github.com/cyber-shuttle/cs-jupyter.git
```

## 3. Start the database

```bash
docker compose -f airavata/dev-tools/compose/compose.yml up -d --wait postgres
```

## 4. Start the CyberShuttle API

Build the server, then start it in the background. The root token signs you in as the administrator, and step 5 uses
it.

```bash
cd airavata
go build -o bin/airavata-server ./cmd/airavata-server

export AIRAVATA_PUBLIC_URL=$API_URL
export AIRAVATA_CORS_ALLOWED_ORIGINS=$SITE_URL
export AIRAVATA_ROOT_ACCOUNT_TOKEN=$(openssl rand -hex 32)
./bin/airavata-server > airavata.log 2>&1 &
API_PID=$!
cd ..
```

Wait for the server to answer.

```bash
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 "$API_URL/health"
```

The reply is `{"status":"UP"}`. If the command fails, read `airavata/airavata.log`.

## 5. Register a cluster and the Jupyter application

Users can only pick clusters that an administrator has registered. This step registers one cluster. It then tells the
API how to start Jupyter on that cluster.

First define a helper that calls the API as the administrator.

```bash
api() {
  curl -fsS -H "Authorization: Bearer $AIRAVATA_ROOT_ACCOUNT_TOKEN" -H 'Content-Type: application/json' \
    "$API_URL/api/v1/$1" "${@:2}"
}
```

Register the cluster. Replace the name and the login host with your own.

```bash
CLUSTER_ID=$(api slurm-clusters \
  -d '{"clusterName": "hpc-a", "headnodeHost": "login.hpc-a.example.edu", "headnodePort": 22}' |
  jq -r .slurmClusterId)
```

Register the application.

```bash
TEMPLATE_ID=$(api application-templates -d '{"templateName": "Jupyter"}' | jq -r .templateId)
```

Write the commands that each job runs. They ask [Linkspan](https://github.com/cyber-shuttle/linkspan) for a Jupyter
server, then keep the job alive.

```bash
cat > jupyter-run.sh <<'RUN'
curl -fsS -o /dev/null --retry 30 --retry-connrefused --retry-delay 1 -H 'Content-Type: application/json' -d @- \
  "http://127.0.0.1:$CS_CONTROL_PORT/api/v1/jupyter/sessions" <<EOF
{"addr": "127.0.0.1:$CS_APP_PORT", "token": "$CS_APP_TOKEN", "root_dir": "$PWD"}
EOF
sleep infinity
RUN
```

Bind the application to the cluster. The allocation is a placeholder, because each session names its own.

```bash
jq -n --arg template "$TEMPLATE_ID" --arg cluster "$CLUSTER_ID" --rawfile run jupyter-run.sh \
  '{templateId: $template, slurmClusterId: $cluster, slurmRunSection: $run,
    defaultBatchJobConfig: {wallTimeMinutes: 60, allocation: "default", cpus: 2, mem: "4G"}}' |
  api slurm-deployments -d @- | jq -r .deploymentId
```

The command prints the id of the new binding. For each further cluster, repeat the cluster command and the binding
command.

## 6. Build the site

```bash
cd cs-jupyter
bun install --frozen-lockfile
uv sync --frozen
bun run build
```

The build writes the site to `dist/`. It leaves the API's address empty, so set it now.

```bash
perl -pi -e 's#("cybershuttlePlaneApiUrl": *)"[^"]*"#$1"$ENV{API_URL}/api/v1"#' dist/jupyter-lite.json
grep cybershuttlePlaneApiUrl dist/jupyter-lite.json
```

The second command prints the line you just set. Every `bun run build` empties it again, so repeat this block after
each build.

## 7. Serve the site

```bash
python3 -m http.server 8000 --directory dist
```

The server runs in the foreground. Ctrl-C stops it.

## 8. Check it

Open a second shell for these checks.

```bash
curl -fsS http://localhost:9095/health
curl -fsS -H 'Origin: http://localhost:8000' http://localhost:9095/api/v1/auth/config
curl -fsS http://localhost:9095/api/v1/slurm-clusters | jq -r '.[].clusterName'
```

| Command | A good reply                                    |
| ------- | ----------------------------------------------- |
| First   | `{"status":"UP"}`                               |
| Second  | A JSON object that names your CILogon client id |
| Third   | The cluster you registered                      |

Then open <http://localhost:8000/lab/index.html> and choose **Sign in**. After the CILogon page, your account name
shows on the **CyberShuttle** row. **Compute Hosts** offers the cluster you registered. The [user guide](USING.md)
continues from there.

## Stopping

Stop the site with Ctrl-C. Then stop the API and the database from the folder that holds both checkouts.

```bash
cd ..
kill $API_PID
docker compose -f airavata/dev-tools/compose/compose.yml down
```

The database keeps its records in a Docker volume. Add `--volumes` to the last command to delete them.

## Deploying for real

A deployment runs the same three services. Only the settings change.

| Setting                          | Local value                | On a server                                                 |
| -------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `API_URL`, `AIRAVATA_PUBLIC_URL` | `http://localhost:9095`    | The API's public HTTPS origin, reachable from compute nodes |
| `SITE_URL`                       | `http://localhost:8000`    | The site's public HTTPS origin                              |
| `AIRAVATA_CORS_ALLOWED_ORIGINS`  | `$SITE_URL`                | The site's exact origin. The default `*` admits any site.   |
| CILogon callback URL             | `$SITE_URL/lab/index.html` | The same path on the public site                            |
| `AIRAVATA_ROOT_ACCOUNT_TOKEN`    | Made in step 4             | Made once and kept on the server                            |
| The database                     | The compose file           | A PostgreSQL with its own password and TLS                  |
| The site                         | `python3 -m http.server`   | Any static file server, such as nginx                       |

Three rules hold for `cybershuttlePlaneApiUrl`.

- It is `AIRAVATA_PUBLIC_URL` followed by `/api/v1`. The site accepts a session's address only beneath this URL.
- It is an absolute HTTPS URL, or an HTTP URL on `localhost`. It carries no credentials, query or fragment. The site
  refuses to start otherwise.
- It is set in the served `dist/jupyter-lite.json` after every build. The copy in the repository stays empty, and
  `tests/distribution.mjs` fails if a value is committed.

The site can be served from any path, because the build uses relative URLs.

[cs-infra](https://github.com/cyber-shuttle/cs-infra) holds a complete deployment of both services on one VM. Its
`deployment-csvm/up.sh` runs the steps above against a server. Its `register-cluster.sh` runs step 5.

The remaining API settings are in `INSTALL.md` of the Airavata checkout.
