# Private npm registry

**What:** the package registry the builder installs npm packages from when it publishes an app.
**Owner:** registry owner. **For:** the builder owner, and anyone who runs, changes or rebuilds the registry.
**Status (2026-11-16):** running on host 1, **offline** (no link to npmjs). Packages are loaded beforehand by the seed tool. Publishes verified on both VMs.
**Why things are the way they are:** [DECISIONS.md](DECISIONS.md).

| In this folder | What it is | Where it lives on host 1 |
|---|---|---|
| [verdaccio/config.yaml](verdaccio/config.yaml) | Live config (offline mode) | `/etc/verdaccio/config.yaml` |
| [verdaccio/config.online.yaml](verdaccio/config.online.yaml) | Previous online config, for rollback | `/etc/verdaccio/config.online.yaml` |
| [verdaccio/verdaccio.service](verdaccio/verdaccio.service) | systemd unit | `/etc/systemd/system/verdaccio.service` |
| [seed/](seed/README.md) | Seed tool: loads an app's packages into the registry | `/opt/verdaccio-seed/`, `/etc/verdaccio-seed/`, `/etc/systemd/system/verdaccio-seed-inbox.*` |

Secrets are **not** in this repo: `htpasswd`, the seed tool's token file and `.verdaccio-db.json` stay on host 1 only.

---

## 0. Read first: rules

| Rule | Why |
|---|---|
| **Never use the EFS mount** for registry work, and never write to release folders | Shared with other work; release files belong to the builder |
| **No AWS changes** (security groups, instances, IAM, EFS) without asking the registry owner first | Nothing in this setup needed one |
| **Don't change the `verdaccio` service**, `/etc/verdaccio/` or `/var/lib/verdaccio/` on host 1 without telling the registry owner | Every config change restarts the registry (~3 s), which fails publishes running at that moment |
| **Don't set `NPM_CONFIG_REGISTRY`** anywhere the builder runs | It silently overrides the `.npmrc` the builder writes (section 5) |

---

## 1. In one minute

- Every generated app needs **npm packages** (React, Vite, Chakra UI…) to build.
- Normally `npm install` downloads them from the **public registry** on the internet (npmjs). The bank's VMs **have no internet**, and the bank's own registry has **no link to npmjs** either: packages must be loaded into it before anyone can use them.
- Our **private registry** replicates that: **Verdaccio 6.11.1** on host 1, **`http://172.31.47.239:4873/`**, with no link to npmjs. It serves only packages that were **loaded beforehand** by the **seed tool**.
- A package that isn't loaded **fails the publish with `404`**. Load it with the seed tool (section 10.1), then publish again.
- The builder on both VMs uses it (`NPM_REGISTRY`). Real publishes after going offline worked on both VMs, with **0** requests to npmjs.
- It's only needed **while publishing** (install + build). Running apps never contact it.

---

## 2. What is a package registry?

### 2.1 Public vs private

| | **Public registry** (npmjs, `registry.npmjs.org`) | **Private registry** (ours: Verdaccio; in the bank: JFrog Artifactory) |
|---|---|---|
| Who runs it | npm, Inc. (on the internet) | Us, inside our network |
| What it holds | Every public package (millions) | Only the public packages we loaded, plus our own **internal** packages |
| Who can reach it | Anyone with internet | Only our VMs |
| Control | None: whatever is published is available | We decide what's loaded, can block versions, and nothing changes unless we load it |

### 2.2 Words used in this document

| Word | Meaning |
|---|---|
| **npm** | Node's package manager. `npm install` downloads packages; `npm ci` installs exactly what a lockfile says |
| **Package registry** | A server npm downloads packages from. Not to be confused with the **app registry** (`registry/<appId>.json`) that the proxy uses for routing |
| **Uplink / proxy** | A registry's link to another registry (npmjs) to fetch packages it doesn't have. **Ours has none since 2026-11-16** |
| **Offline registry** | A registry with no uplink: it serves only what was loaded into it |
| **Seed tool** | Our script on host 1 that downloads an app's packages from npmjs and loads them into the registry |
| **Metadata** | A package's version list (`GET /react`). npm reads it to choose a version |
| **Tarball (`.tgz`)** | The package file itself. Downloaded after a version is chosen |
| **`.npmrc`** | npm's config file. Its `registry=` line decides where npm downloads from |
| **`package-lock.json`** | Records the exact version and download URL (`resolved`) of every installed package |
| **Scope** | A name prefix like `@lab/`. We use `@lab/*` for internal packages |
| **devDependencies** | Packages needed only to build (Vite). The builder installs them with `--include=dev` |
| **Native package** | A package with compiled code for one platform. The current app (Vite 5) needs `@esbuild/linux-x64` and `@rollup/rollup-linux-x64-gnu`; Vite 8 would need `@rolldown/binding-linux-x64-gnu` instead |

---

## 3. Why we need it

| Problem without it | How the private registry helps |
|---|---|
| **VMs have no internet**, so `npm install` fails | VMs only talk to the registry |
| **The bank's registry has no link to npmjs** | Our offline mode behaves the same way, so the PoC hits the same problems the bank will |
| **Versions change by themselves** (Vite released 12 versions in 60 days) | Offline, `npm install` can only pick versions that were loaded: the same versions every publish |
| **Vulnerable versions** could get into apps | The seed tool refuses blocklisted versions; the registry can also block versions (section 8.3) |
| **Internal packages** (shared UI kits, helpers) have nowhere private to live | Published to the registry under `@lab/*`, never public |
| **Dependency confusion**: someone publishes a public package with our internal name | Nothing comes from npmjs automatically, and the seed tool never downloads `@lab/*` |
| **Audit trail** | The registry log shows which VM downloaded what; seed tool reports show what was loaded and when |

---

## 4. How it fits the publish flow

```
  BEFORE (registry owner, when an app needs new packages)
    seed tool on host 1 ── downloads from npmjs ──► loads into the registry
                                                     (only the seed tool talks to npmjs)

  PUBLISH (builder, on host 1 or host 2)
    1. generates the Vite + React project on LOCAL disk
    2. writes .npmrc:  registry=$NPM_REGISTRY      ◄── the only link to the registry
    3. npm install --include=dev ──────────────────► Private registry (host 1:4873)
    4. npm run build  (BASE_PATH=/apps/<appId>)       Verdaccio 6.11.1, offline:
    5. copies dist/, server.js, package*.json,        answers from its own disk only;
       .env.build to shared releases/<n>/            not loaded → 404 → publish fails
    6. starts node server.js (no npm needed)
```

- **Only steps 3 and 4 use packages.** A release holds no `node_modules`, so any VM can run it without the registry.
- **Lockfile proof:** after a publish, every `resolved` URL in the release's `package-lock.json` starts with `http://172.31.47.239:4873/`.

---

## 5. What the builder must have (done on both VMs)

In the builder's systemd environment file `/etc/builder/builder.env` on **both** VMs:

```bash
NPM_REGISTRY=http://172.31.47.239:4873/      # same value on every VM, including host 1 (never localhost)
NPM_CONFIG_UPDATE_NOTIFIER=false             # stops npm checking for a newer npm on every install
```

| Do | Don't |
|---|---|
| Use the **same URL** on every VM, so lockfiles look the same everywhere | Use `localhost` (even on host 1): lockfiles made on host 1 would break on host 2 |
| Let the builder write the project `.npmrc` from `NPM_REGISTRY` (generated code stays unchanged) | Set `NPM_CONFIG_REGISTRY`. npm's order is: command-line flag > **environment variable** > project `.npmrc`, so it would override the builder's choice without any warning |
| Keep `npm install --include=dev` | Drop `--include=dev`: the builder runs with `NODE_ENV=production`, so Vite (a devDependency) would be skipped and the build fails with `vite: not found` |

**Check the running builder has it:**
```bash
PID=$(systemctl show -p MainPID --value builder)
sudo cat /proc/$PID/environ | tr '\0' '\n' | grep -i '^npm'
# expect NPM_REGISTRY=... and NPM_CONFIG_UPDATE_NOTIFIER=false, and NOT NPM_CONFIG_REGISTRY
```

**Check a publish used it** (builder owner: the release is on the EFS mount, which registry work never touches; `grep` only reads it):
```bash
REL=/mnt/shared/apps/<ait>/<appId>/releases/<n>
grep -c '"resolved": "http://172.31.47.239:4873/' "$REL/package-lock.json"     # > 0
grep -c '"resolved": "https://registry.npmjs.org/' "$REL/package-lock.json"    # 0
```
Registry owner, without touching the release: count the VM's requests in the registry log on host 1 during the publish (section 10).

---

## 6. What is running now

| Item | Value |
|---|---|
| Software | **Verdaccio 6.11.1** (open-source npm registry), no Docker |
| Host | **Host 1** `i-0ca80950b15dcbfad`, private IP **172.31.47.239** (also a builder VM). Amazon Linux 2023, 2 vCPU, 3.7 GiB RAM |
| **URL** | **`http://172.31.47.239:4873/`** (HTTP, inside the VPC only) |
| Mode | **Offline** since 2026-11-16 08:12: no uplink; only the seed tool downloads from npmjs |
| Service | systemd `verdaccio.service`, user `verdaccio`, active and enabled at boot, restarts on failure |
| Node.js | **Its own** v22.22.1 in `/opt/verdaccio/node`, separate from the host's Node (v26 via nvm). Changing the host's Node can't break the registry |
| Config | `/etc/verdaccio/config.yaml` = [verdaccio/config.yaml](verdaccio/config.yaml). `config.online.yaml` = the previous online config |
| Data | `/var/lib/verdaccio/storage` (packages), `/var/lib/verdaccio/htpasswd` (users). **162 package files** at 2026-11-16: `demo-app-1`'s 157 + 5 `@lab` |
| Rollback data | `/var/lib/verdaccio/storage.online-20261116` (old online storage, 870 MB, 1062 files) |
| Backups | `/var/backups/verdaccio/verdaccio-20261116-0646.tar.gz` (234 MB, last online state) and `verdaccio-20261106-1739.tar.gz`; mode 600, folder 700, on host 1 itself |
| Who can reach it | Only instances in security group `sg-04183aea5e2c51b14` (rule: tcp 3000–9000 from itself). **Not** reachable from the internet (tested) |
| Seed tool | `/opt/verdaccio-seed/seed-registry.sh`, user `verdaccio-seed`, inbox `/var/lib/verdaccio-seed/inbox/` watched by `verdaccio-seed-inbox.path` ([seed/README.md](seed/README.md)) |
| Install | **Anonymous**: no login needed on any VM |
| Publish internal `@lab/*` packages | Login needed (user `lab-admin`, registry owner only) |
| Sign-up | **Off** (`max_users: -1`): nobody can create new accounts |
| Internal packages present | `@lab/hello` 1.0.0–1.0.3, `@lab/app` (test packages) |
| Web UI | Not exposed. Registry owner uses SSM port forwarding to `http://localhost:14873` |

**Config in plain words** ([verdaccio/config.yaml](verdaccio/config.yaml)):

| Rule | Effect |
|---|---|
| `listen: 0.0.0.0:4873` | Other VMs can connect (the native default is localhost only) |
| No `uplinks`, no `proxy` lines | Offline: served only from storage; nothing is fetched automatically |
| `access: $all`, `publish: $authenticated` | Anyone on the network installs; only logged-in users publish (the seed tool uses its own copy of the `lab-admin` token) |
| `audit: enabled: false` | `npm audit` isn't forwarded anywhere (nothing to forward to) |
| `max_body_size: 100mb` | The seed tool's uploads fit (base64, ~1.35× the package; native packages ~9 MB, above Verdaccio's 10 MB default) |
| No `filters:` | No block rules active (they were tested, section 8.3) |

---

## 7. What we did, step by step

### 7.1 Stage 1: learning on a laptop (Docker, 2026-11-02 to 11-04)

| Step | What | What we learned |
|---|---|---|
| 1–2 | Verdaccio in Docker | Starting a registry; its web UI |
| 3 | Point npm at it, install `lodash` | Config order (env > `.npmrc`); the registry caches metadata and tarballs; **npm's own cache can hide the registry**, so tests use an empty cache; a registry that can't reach npmjs answers **404**, not "network error" |
| 4 | Publish a private `@lab/hello` | Versions can't be overwritten; anyone installs, only logged-in users publish. **Near miss:** a terminal without the registry setting almost published to public npmjs (fix: `publishConfig.registry` in internal packages) |
| 5 | Config file + persistent storage | `@lab/*` not proxied (dependency confusion closed); a lost version breaks every lockfile pinned to it, so **registry data must be backed up** |
| 6 | Two simulated VMs build a Vite + React app | Builder-written `.npmrc` works; **`--include=dev` is required**; native packages are needed; `npm ci` also fetches the `-musl` variants; the second VM needs **no registry at all** to run the app |
| 7 | VMs with no internet (Docker internal network) | Publish works from the registry alone. Registry with no internet: only stored packages work; a never-fetched package gives a **misleading 404**; a missing native package makes `npm ci` succeed but the **build fail** |
| 8 | Artifactory trial | **Skipped**: the builder only needs one URL, so moving to Artifactory changes the URL, not the flow |

### 7.2 Stage 2: AWS (host 1 + host 2, 2026-11-05 to 11-16)

| Step | What | Result |
|---|---|---|
| 1 | Look at both hosts (read-only) | Identical: Amazon Linux 2023, 3.7 GiB RAM, 18 GB free, port 4873 free, npmjs reachable, Node via nvm (invisible to root) |
| 2 | Docker installed, then removed | Team chose no Docker on the hosts |
| 3 | Verdaccio as a systemd service with its own Node | Running on `0.0.0.0:4873`, `npm view react` works |
| 4 | Reach it from host 2 | Works with **no security-group change** (existing rule allows tcp 3000–9000 between the two hosts). Not reachable from the internet |
| 5 | User, internal package, sign-up off | `@lab/hello` published by `lab-admin`; host 2 installs it with no login; new sign-ups refused |
| 6 | **Builder on both VMs uses the registry** | Host 2: app `demo-app-1`, **207** `resolved` → registry, **0** → npmjs. **Host 1 was found with `NPM_REGISTRY` empty on 2026-11-13** (its publishes had gone to npmjs); set by the registry owner, then verified: app `1000` published, ~244 registry requests from host 1, all OK |
| 7 | Registry without internet (temporary systemd IP block on the service) | Stored packages install; never-fetched `dayjs` → **404** while the log says `ENOTFOUND registry.npmjs.org`. Block removed afterwards |
| 8 | Build with **no internet** on host 2 (per-process block, nothing changed on the host) | Vite + React installed and built from the registry alone |
| 9 | Backup, restart, restore drill | Backup 230 MB; restart ~3 s with data intact; restored copy identical; starts at boot |
| 10 | **Block vulnerable versions** (built-in `@verdaccio/package-filter`) | All 9 acceptance cases pass (section 8.3). Config returned to no rules afterwards |
| 11 | **Offline registry + seed tool** (2026-11-13 to 11-16) | npmjs link removed; storage restarted empty (kept `@lab` and `.verdaccio-db.json`); seed tool loaded `demo-app-1`'s **157** Linux packages (47 other-platform skipped) in ~2 min, integrity checked. Host 2: `npm ci` + build and builder-style `npm install` work from the registry alone; `dayjs` → 404; 0 requests to npmjs. Real publishes OK on **both** VMs. Publish outage while switching: ~17 min |

---

## 8. How it behaves (test results you can rely on)

### 8.1 Offline registry (current mode)

| Situation | Result |
|---|---|
| Package and version loaded | Installs normally, with `npm ci` and `npm install` |
| `npm install` without lockfile (what the builder does) | Picks from the **loaded versions only**, so no drift; same versions as the seed lockfile |
| Package not loaded | **`404 … no such package available`** → publish fails. Load it with the seed tool (10.1) |
| Package loaded, but one of its dependencies isn't | Fails naming the **dependency**, not the package you asked for |
| Native packages for other platforms (`@esbuild/darwin-…`, `fsevents`, `@rollup/rollup-win32-…`) | Not loaded on purpose. npm asks, gets `404`, skips them. **These 404 lines in the log are normal** |
| Optional peer `@types/react` | `404` in the log, harmless (only needed for TypeScript) |
| `GET /npm` → 404 | npm's update check from a terminal without `NPM_CONFIG_UPDATE_NOTIFIER=false`. Harmless |
| npm 11 `install scripts not yet covered by allowScripts` | Warning only (esbuild's install script). Builds work |

### 8.2 If a native package is missing

| Missing | Result |
|---|---|
| One for another platform or libc (e.g. `-musl`) | Install succeeds; can be ~1 min slower (npm retries) |
| The one this platform needs (e.g. `@rollup/rollup-linux-x64-gnu`) | The install **succeeds**, then the **build fails** with a message blaming an npm bug with optional dependencies. The real cause is at the bottom of the error: `Cannot find module '<native package>'`. Load it with the seed tool |

### 8.3 Blocking versions (tested 2026-11-07; no rules active now)

Two places can block: the **seed tool's blocklist** (`/etc/verdaccio-seed/blocklist.txt`: a blocked version is never loaded) and **registry rules** (`filters:` in `config.yaml`, each change needs a restart).

| Registry rule | What npm sees |
|---|---|
| Block one version (`@lab/hello` 1.0.3) | `^1.0.0` → 1.0.2; exact `@1.0.3` → `ETARGET No matching version found`; dependents get 1.0.2 |
| Same, but a lockfile made **before** the block pins 1.0.3 | `npm ci` fails with `404` on the tarball: a lockfile **cannot** sneak a blocked version in |
| Block a range (`lodash <4.17.21`, real CVE) | `lodash@4.17.20` → `ETARGET`; `^4.17.0` → 4.18.1 |
| Block every version | `ENOVERSIONS` |
| `strategy: replace` | Serves the older version's content under the blocked number; lockfile becomes inconsistent. **Emergency use only** |
| Quarantine `minAgeDays: 30` | Hides every release younger than 30 days (including security fixes). Policy decision |

**None of these errors say "blocked by policy".** The builder should explain `ETARGET`, `ENOVERSIONS` and `404` during a publish as "missing or blocked in the registry".

### 8.4 Online mode (history, until 2026-11-16)

With an uplink, missing packages were fetched from npmjs on first request and cached; the registry rechecked version lists every 2 min (`304` lines in the log). If npmjs was unreachable, a never-fetched package gave a misleading `404`. To go back to this mode, see 10.2.

---

## 9. Troubleshooting

| You see (during publish) | Likely cause | What to do |
|---|---|---|
| `E404 … is not in this registry` / `no such package available` | **The package isn't loaded.** Normal for a new package | Send the app's `package.json` to the registry owner, who loads it with the seed tool (10.1), then publish again. Ignore other-platform 404s in the log (8.1) |
| `ETARGET No matching version found` | Version blocked, not loaded, or doesn't exist | Check whether it's loaded (`npm view <pkg> versions --registry http://172.31.47.239:4873/`), then `filters:` in the config |
| `ENOVERSIONS` | All versions of that package blocked | Check `filters:` |
| Build fails: "npm has a bug related to optional dependencies" / `Cannot find module '<native package>'` | A native package is missing from the registry | Load it with the seed tool |
| `vite: not found` | devDependencies skipped (`NODE_ENV=production` without `--include=dev`) | Keep `--include=dev` |
| `ECONNREFUSED 127.0.0.1:4873` | A lockfile made against `localhost` | Always use the private IP. Or set `NPM_CONFIG_REPLACE_REGISTRY_HOST=always` |
| `ETIMEDOUT` / `ECONNREFUSED 172.31.47.239:4873` | Registry restarting (~3 s) or stopped | `systemctl is-active verdaccio`; retry the publish |
| Lockfile shows `registry.npmjs.org` | Builder not using the registry (`NPM_REGISTRY` missing or empty, or `NPM_CONFIG_REGISTRY` overriding it) | Check the builder's environment (section 5) |
| `EAI_AGAIN` / `ENOTFOUND registry.npmjs.org` on a VM | npm is going to npmjs directly | Same |
| `EPUBLISHCONFLICT` | Republishing an existing version of an internal package | Bump the version |
| Seed tool exit 3 | A version in its blocklist, or a git / file / URL dependency | See the report in `/var/lib/verdaccio-seed/reports/` |

---

## 10. Day-to-day operations (on host 1, by the registry owner)

```bash
systemctl is-active verdaccio verdaccio-seed-inbox.path        # active active
curl -s http://172.31.47.239:4873/-/ping                        # {}
sudo journalctl -u verdaccio --since "-15 min" --no-pager       # recent requests
sudo du -sh /var/lib/verdaccio                                  # disk used

# Backup (data + config + unit), root-only because it contains htpasswd
B=/var/backups/verdaccio/verdaccio-$(date +%Y%m%d-%H%M).tar.gz
sudo tar -czf $B -C / var/lib/verdaccio etc/verdaccio etc/systemd/system/verdaccio.service && sudo chmod 600 $B

# Restart (~3 s outage: tell the builder owner first)
sudo systemctl restart verdaccio
```

### 10.1 Load packages (seed tool)

```bash
# Automatic: put a package.json or package-lock.json in the inbox (copy as .part, then rename)
sudo install -m 644 package.json /var/lib/verdaccio-seed/inbox/myapp.part
sudo mv /var/lib/verdaccio-seed/inbox/myapp.part /var/lib/verdaccio-seed/inbox/myapp.json
sudo journalctl -u verdaccio-seed-inbox.service -f      # RESULT line, then Ctrl+C
sudo ls /var/lib/verdaccio-seed/done /var/lib/verdaccio-seed/failed

# Preview only (nothing loaded)
sudo -u verdaccio-seed /opt/verdaccio-seed/seed-registry.sh --list-only /path/to/package-lock.json
```

It loads only what is missing (reruns are cheap), skips other-platform natives and `@lab`, refuses anything in the blocklist, uploads the original files and checks integrity. Exit codes: 0 OK, 1 failed, 2 list-only found missing, 3 blocked or unsupported. Details and install steps: [seed/README.md](seed/README.md).

### 10.2 Back to online mode (rollback)

```bash
sudo systemctl disable --now verdaccio-seed-inbox.path
sudo systemctl stop verdaccio
sudo cp -a /etc/verdaccio/config.yaml /etc/verdaccio/config.offline.yaml
sudo cp -a /etc/verdaccio/config.online.yaml /etc/verdaccio/config.yaml
sudo mv /var/lib/verdaccio/storage /var/lib/verdaccio/storage.offline-$(date +%Y%m%d)
sudo mv /var/lib/verdaccio/storage.online-20261116 /var/lib/verdaccio/storage
sudo systemctl start verdaccio
```
Tell the builder owner before and after (publishes fail while the registry is stopped).

---

## 11. Known limits and open items

IDs refer to [DECISIONS.md](DECISIONS.md).

| Item | Status / proposal | Owner |
|---|---|---|
| **New packages need loading first** | A generated app with a package that isn't loaded fails with 404 until the seed tool loads it | Registry owner |
| **P2-29: which packages can generated apps use?** | Fixed template set → seed only on template changes; any package → seeding needed before each publish (builder pre-check) | Team (open) |
| **P2-30: how the bank adds packages** | Approval or scan? The seed tool's `--list-only` report is ready for an approval process | Team (open) |
| **P1-30: pinned lockfile + `npm ci`** | Identical builds, and the lockfile becomes the seed list. Offline mode already prevents drift, but only within loaded versions | Builder owner (to discuss) |
| **P1-32: pin the Vite major** | The major decides which native packages must be loaded (Vite 5: esbuild + rollup; Vite 8: rolldown + lightningcss) | Builder owner (to discuss) |
| **Clearer builder errors** | Turn `404` / `ETARGET` / `ENOVERSIONS` / `Cannot find module '<pkg>'` into "package missing or blocked in the registry" | Builder owner |
| **HTTP, not HTTPS** | Fine inside the VPC for the PoC; HTTPS required for the bank | Registry owner (Phase 3) |
| **Single host**, no failover | If host 1 is down, publishes fail (running apps are unaffected). Backup exists for a rebuild | Registry owner |
| **Backup only on host 1** | Copy it off-host for anything real | Registry owner (Phase 3) |
| **P2-15: Node v24 for the registry** | Verdaccio recommends v24; v22 works. Swap before Phase 3 | Registry owner |
| **P2-20: block list source** | Maintained by hand (no CVE feed). Bank: Artifactory Xray / Curation (Q20) | Team |

---

## 12. Moving to the bank environment

The builder needs **one URL**. In the bank, `NPM_REGISTRY` becomes the bank's Artifactory npm URL; nothing else in the publish flow changes.

| Here (Verdaccio, offline) | In the bank (Artifactory, no npmjs link) |
|---|---|
| Seed tool loads packages from npmjs | The bank's process for requesting / approving packages (P2-30) |
| `@lab/*` stored locally | **Local** repo for internal packages, with the bank's scope name |
| One URL for everything | Virtual repo URL the VMs use |
| Seed blocklist / `package-filter` rules | Xray / Curation policies |
| Anonymous install | Anonymous read, or a token passed through the environment (never in generated code) |
| HTTP inside the VPC | HTTPS; the VMs may need the bank's CA certificate |

**Questions for the bank's Artifactory team:** the npm repo URL; how packages get added and how long it takes; anonymous read or token; Xray / Curation; HTTPS certificate; the internal scope name; whether we administer it or only consume it (P1-46).

---

## 13. Who owns what

| Area | Owner |
|---|---|
| Registry (host 1 `verdaccio`, config, data, backups, block rules, seed tool) | Registry owner |
| Builder, proxy, reconciler, `/etc/builder/builder.env`, generator template | Builder owner |
| Shared decisions (P1-30, P1-32, P2-29, seed list, error messages) | Both |

---

## Appendix: rebuild the registry (if host 1 is replaced)

Run on the new host as `ssm-user` (has sudo).

```bash
# 1. Service user and folders
sudo useradd --system --home-dir /var/lib/verdaccio --shell /usr/sbin/nologin verdaccio
sudo mkdir -p /opt/verdaccio /etc/verdaccio /var/lib/verdaccio/storage
sudo chown -R verdaccio:verdaccio /var/lib/verdaccio

# 2. Own Node.js, checksum checked
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.22.1/node-v22.22.1-linux-x64.tar.gz
curl -fsSL https://nodejs.org/dist/v22.22.1/SHASUMS256.txt | grep ' node-v22.22.1-linux-x64.tar.gz$' | sha256sum -c -
sudo mkdir -p /opt/verdaccio/node
sudo tar -xzf node-v22.22.1-linux-x64.tar.gz -C /opt/verdaccio/node --strip-components=1
rm node-v22.22.1-linux-x64.tar.gz

# 3. Verdaccio, pinned, in its own prefix
sudo env PATH=/opt/verdaccio/node/bin:/usr/bin:/bin npm install -g --prefix /opt/verdaccio verdaccio@6.11.1

# 4. Config and service: the files in verdaccio/ of this repo
sudo install -m 644 verdaccio/config.yaml verdaccio/config.online.yaml /etc/verdaccio/
sudo install -m 644 verdaccio/verdaccio.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now verdaccio

# 5. Data: restore the latest backup (has packages, htpasswd, .verdaccio-db.json)
sudo systemctl stop verdaccio
sudo tar -xzf <backup>.tar.gz -C / var/lib/verdaccio
sudo chown -R verdaccio:verdaccio /var/lib/verdaccio
sudo systemctl start verdaccio

# 6. Seed tool: install as in seed/README.md (needs a lab-admin token on the new host)

# 7. Test
curl -s http://<new-ip>:4873/-/ping                                   # {}
npm view react version --registry http://<new-ip>:4873/               # a loaded version
```

With no backup, the registry starts empty: create `lab-admin` again (temporarily allow sign-up), republish `@lab/*`, and load every app's packages with the seed tool. If the IP changes, update `NPM_REGISTRY` on every builder VM and `REGISTRY_URL` in `/etc/verdaccio-seed/seed.env`. Old lockfiles then need `NPM_CONFIG_REPLACE_REGISTRY_HOST=always`.
