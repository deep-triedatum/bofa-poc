# Reconciler

`reconciler/server.js` keeps the registry true. If a published app dies, or the VM that runs it disappears, the reconciler starts it again from its release on the shared volume and updates the registry. The stable URL (`/apps/<appId>/`) never changes. Only the `ip` and `port` in `registry/<appId>.json` do, and the proxy picks that up within about a second.

It runs on every VM from the shared volume, in plain `node` with no dependencies. It shares its start, health-check, port and registry code with the publisher through `runtime/lifecycle.js`, so the two cannot drift apart.

## What it does each interval

Every `RECONCILE_INTERVAL_MS` (default 5 s) a tick:

1. **Heartbeat:** writes `<shared>/vms/<vm>.json` with the VM name, IP and the current time. A VM whose heartbeat is older than `VM_TIMEOUT_MS` (default 20 s) counts as gone.
2. **Health checks:** requests `GET /healthz` on every registry entry whose `status` is `running`. Entries on this VM are checked on `127.0.0.1`, entries on other VMs on their registered `ip`.
3. **Decides what to do** for each unhealthy app (below).

Healthy apps are left alone.

## Decisions for an unhealthy app

| Situation | Action |
|---|---|
| App is on another VM that has a fresh heartbeat | `skipped`. That VM's own reconciler handles it |
| Fewer than `FAILURES_BEFORE_RESTART` failed checks in a row (default 2) | `suspect`. One slow answer does not restart an app |
| App is on this VM | Restart it here: `restarted` |
| App is on a VM that is gone, and this VM is the elected adopter | Start it here: `adopted` |
| App is on a VM that is gone, and another live VM is the elected adopter | `left-to-other-vm` |
| The release is missing from the shared volume | Registry `status` set to `failed`: `failed` |
| The new process never became healthy | Stopped again, registry unchanged: `start-failed` |
| The registry entry changed while the new process was starting | New process stopped: `superseded` |

A VM with no heartbeat file at all is treated as gone, but only once its apps also fail their health checks. So a VM that is simply not running a reconciler does not lose healthy apps.

### Which VM adopts an app

Every live VM computes the same answer from the same heartbeats: the live VM names are sorted, and `sha1(appId)` picks one by index. There is no lock and no coordination, and adopted apps spread across VMs.

If two VMs briefly disagree (for example their clocks differ at the edge of the timeout), both may start the app. Before writing the registry, each re-reads the entry and compares it with what it saw at the start of the tick. Only the first writer succeeds, and the other stops its new process (`superseded`).

## Restarting an app

1. Find the release directory `<shared>/apps/<ait>/<appId>/releases/<release>/` from the entry.
2. For an app on this VM, stop the old process first, then wait briefly for the port.
3. Pick a port. A restart on the same VM tries the old port first, so the registry usually does not change at all except for the pid. An adoption takes the first free port in `PORT_MIN` to `PORT_MAX`, skipping ports claimed by other entries for this VM.
4. Start `node server.js` there with `PORT` and `BASE_PATH`, and wait for `/healthz`.
5. Write the registry entry atomically with the new `vm`, `ip`, `port`, `pid`, `updatedAt` and an incremented `restarts` counter.

The release holds only `dist/`, `server.js` and the package files, so nothing is built again.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHARED_DIR` | `./.shared` | Shared volume root |
| `VM_NAME` | hostname | This VM's name. Must match the publisher's `VM_NAME` on the same VM |
| `VM_IP` | `127.0.0.1` | Address other VMs use to reach this VM |
| `PORT_MIN`, `PORT_MAX` | `20000`, `20999` | Port range for this VM |
| `RECONCILE_INTERVAL_MS` | `5000` | Time between ticks |
| `VM_TIMEOUT_MS` | `20000` | Heartbeat age after which a VM counts as gone. Keep it well above the interval |
| `FAILURES_BEFORE_RESTART` | `2` | Consecutive failed checks before an app is restarted |

## Running it

```bash
# on every VM, from the builder directory
SHARED_DIR=/shared VM_NAME=vm1 VM_IP=172.56.7.2 npm run reconciler
```

Run it under the VM's process manager (systemd, for example) so it restarts on failure. Published apps run detached, so stopping or restarting the reconciler does not stop them. It logs one line per action (`restarted`, `adopted`, and so on) and stays quiet for healthy apps.

## Verified

- `npm run reconciler:test` runs 8 tests against real stand-in servers and a temporary shared directory:
  - a healthy app is left alone;
  - a dead app is restarted on the same port with `restarts` incremented;
  - the failure threshold is respected (`suspect`, then `restarted`);
  - an app on a VM with no heartbeat is adopted;
  - an unhealthy app whose VM has a fresh heartbeat is not touched;
  - a missing release marks the app `failed`;
  - the heartbeat is written;
  - the adopter choice is stable regardless of list order and uses both VMs.
- End to end, with the real builder, proxy, reconciler and a published app: after the app process was killed, the stable URL returned 502 and then 200 again after about 3 seconds, and the registry showed a new pid on the same port with `restarts` 1.
- Not tested: two real VMs. Adoption was exercised on one machine with a registry entry that points at a VM with no heartbeat.

## Current limits

- **Clocks:** the heartbeat compares timestamps written by one VM with the time on another, so the VMs' clocks must agree to within a few seconds (use NTP).
- **Unreachable is not gone:** if the network between VMs breaks while both VMs stay up, each still has a fresh heartbeat on the shared volume, so nothing is adopted. If the shared volume itself is down, nothing works.
- **Slow start counts as a failure:** an app that takes longer than 15 seconds to answer `/healthz` after a restart is stopped and reported as `start-failed`. The next tick tries again.
- **`failed` is final:** an app marked `failed` (release missing) is not retried. It needs a new publish.
- **No identity:** restarted apps run as the user running the reconciler, not as the AIT's service ID.
- **Detached processes are not supervised:** between ticks a crashed app is down for up to `RECONCILE_INTERVAL_MS` times `FAILURES_BEFORE_RESTART` plus the start time.
