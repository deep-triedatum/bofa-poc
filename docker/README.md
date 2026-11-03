# Local test with Docker Compose

Files: `docker-compose.yml` and `.dockerignore` in `bofa-poc/`, and in `bofa-poc/docker/`: `Dockerfile`, `entrypoint.sh`, `nginx.conf`, `smoke.sh` and this file. The image is built from `bofa-poc/` as the context and copies `builder/` into it, so the builder directory holds no Docker files.

`docker-compose.yml` runs the whole design on one machine, with two containers standing in for your two VMs.

```
                    http://localhost:8080
                            │
                    ┌───────┴───────┐
                    │  lb (nginx)   │   alternates requests, so a user lands on a random "VM"
                    └───┬───────┬───┘
              ┌─────────┘       └─────────┐
        ┌─────┴──────┐             ┌──────┴─────┐
        │ vm1        │             │ vm2        │   each: editor (3000) + proxy (8080) + reconciler
        │ apps :20000│             │ apps :20000│   published apps run inside the container
        └─────┬──────┘             └──────┬─────┘
              └────────┐       ┌──────────┘
                  ┌────┴───────┴────┐
                  │ volume "shared" │   mounted at /shared in both: apps/, registry/, vms/
                  └─────────────────┘
```

| Real setup | Compose stand-in |
|---|---|
| Two EC2 VMs | Containers `vm1` and `vm2` (`VM_NAME` and `VM_IP` are the container names, which Docker DNS resolves) |
| EFS or NFS shared volume | Docker named volume `shared`, mounted at `/shared` |
| Load balancer or "user lands on any VM" | `lb` (nginx), which alternates between `vm1:8080` and `vm2:8080` |
| Local disk for `npm install` and builds | `/tmp/builder-builds` inside each container |

## Run it

```bash
cd bofa-poc
docker compose up -d --build        # first build takes a few minutes
```

Then:

| URL | What |
|---|---|
| http://localhost:8080 | The editor and your apps, through the load balancer |
| http://localhost:8081 | `vm1` directly |
| http://localhost:8082 | `vm2` directly |

Design a page, click **Publish**, enter an app id such as `my-first-app`, and open the link. It looks like `http://localhost:8080/apps/my-first-app/`, and it works no matter which VM the load balancer picks for a request.

Publishing runs `npm install` inside the container, so it needs internet access unless you set `NPM_REGISTRY` to a private registry (this also tests the `.npmrc` path):

```bash
NPM_REGISTRY=https://artifactory.example/api/npm/npm-virtual/ docker compose up -d --build   # from bofa-poc/
```

## Automated check

```bash
docker/smoke.sh      # from bofa-poc/
```

It publishes two apps through the load balancer, opens each six times (the requests land on both VMs), stops the VM that runs the first app, waits for the other VM to adopt it, checks that the same URL still answers, and starts the stopped VM again. It prints `ALL CHECKS PASSED` or the checks that failed.

## Things to try by hand

```bash
# which VM runs an app, and on which port
docker compose exec vm1 cat /shared/registry/my-first-app.json

# the releases and heartbeats on the shared volume
docker compose exec vm1 ls /shared/apps/default/my-first-app/releases /shared/vms

# watch the reconciler
docker compose logs -f vm1 vm2

# kill the VM that runs the app: the other VM adopts it within about 10 s
docker compose stop vm1            # or vm2
docker compose start vm1

# kill just the app process: the reconciler restarts it in a few seconds
docker compose exec vm1 sh -c 'kill $(node -e "console.log(require(\"/shared/registry/my-first-app.json\").pid)")'

# publish again: a new release starts, the old one stops, the URL stays the same
```

## Settings used

All set in `docker-compose.yml` and shared by both VMs. The timeouts are shorter than the defaults so failover is quick to watch.

| Variable | Value | Why |
|---|---|---|
| `PORT_MIN`, `PORT_MAX` | 20000 to 20099 | Ports for apps inside each container. Not published to the host |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | The stable URL returned to the editor points at the load balancer |
| `RECONCILE_INTERVAL_MS` | 2000 | Default is 5000 |
| `VM_TIMEOUT_MS` | 10000 | Default is 20000 |
| `FAILURES_BEFORE_RESTART` | 2 | Same as the default |
| `NEXT_TELEMETRY_DISABLED` | 1 | Stops Next.js from sending telemetry to an external service |

## How each container starts

`docker/entrypoint.sh` starts the editor, the proxy and the reconciler. If any of them exits, the container exits, and Docker restarts it (`restart: unless-stopped`). On `docker stop` it stops all three. Published apps are detached and stop with the container, which is what simulates a lost VM. `init: true` reaps finished processes.

The `lb` container waits until both VMs report healthy (`/_proxy/health`). If one VM goes down later, nginx sends requests to the other (`proxy_next_upstream`).

## What was and was not tested

Tested here, outside Docker:

- `docker/entrypoint.sh` run directly (from `builder/`, as it runs in the image): the editor, proxy and reconciler all start, `/` and `/_proxy/health` answer through the proxy, and the heartbeat is written.
- If one process exits, the entrypoint exits and leaves nothing running. `SIGTERM` (what `docker stop` sends) stops all three immediately. Testing this found and fixed two bugs: `set -e` skipped the cleanup, and the reconciler lingered for up to one interval after `SIGTERM`.
- `docker-compose.yml` parses, with the anchors and `<<` merges giving the expected two VMs and the load balancer.
- The proxy tests (9) and reconciler tests (8) pass.
- The same publish, URL, restart and failover flow was run end to end on one machine without containers (see `proxy.md` and `reconciler.md`).

**Not tested:** `docker compose up`, the image build, nginx, `docker/smoke.sh`, and the volume mounts. Docker is not installed in the WSL distro this was written in. Expect to fix small things on the first run; `docker compose logs` and the smoke script's output will show where.

## Differences from real VMs

- One Docker network with no firewall, so it does not prove that the app ports are reachable between VMs. On AWS the security group must allow the app port range between the instances.
- Both containers share the host's clock, so it does not test clock drift between VMs.
- A Docker volume is local disk. It does not show NFS or EFS speed or file-locking behaviour.
- Everything runs as root. Running apps as the AIT's service ID is not implemented yet.
- Stopping a container kills its apps instantly. A real VM failure may leave the network half-working.
