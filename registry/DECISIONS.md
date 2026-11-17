# Registry decisions

Why the private npm registry is set up the way it is. One row per decision: the question, the options, what was chosen and why. IDs (P1-n = local learning stage, P2-n = AWS stage) match the registry owner's notes.
Current setup: [README.md](README.md). Last updated: 2026-11-16.

**Status:** Decided · Open (waiting for an answer) · Parked (not needed now).

---

## 1. Scope and tool

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P1-2 | npm only, or npm + PyPI? | npm only / both | **npm only** | Team decision: skip Python for now. Revisit when FastAPI apps are generated | Decided |
| P1-1, P2-1 | Which registry software? | Verdaccio / Artifactory Pro / Nexus | **Verdaccio** for the PoC; Artifactory trial skipped | The builder only needs one registry URL (`NPM_REGISTRY`), so switching to the bank's Artifactory later changes the URL, not the flow. Artifactory OSS has no npm support; Pro needs a licence | Decided |
| P1-4 | Which Verdaccio version? | `latest` / 7.x / 6.11.1 | **6.11.1, pinned** | Mature, matches most guides; same result on laptop, AWS and later | Decided |

## 2. How npm reaches the registry

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P1-7 | How is npm pointed at the registry? | Project `.npmrc` / global config / `--registry` / env `NPM_CONFIG_REGISTRY` | **Builder writes the project `.npmrc` from `NPM_REGISTRY`** | Matches the builder code; generated code stays unchanged because the builder owns that file. `NPM_CONFIG_REGISTRY` must **not** also be set: it would silently override the `.npmrc` | Decided |
| P1-10 | One registry address for all VMs? | One address / per-VM mirrors | **One address** (`http://172.31.47.239:4873/`) on every VM, never `localhost` | Any VM can publish (active-active); lockfile `resolved` URLs must work on every VM | Decided |
| P1-8 | What if the registry address changes (lockfile `resolved` URLs)? | Keep / rewrite / same name everywhere | Same address per environment; `NPM_CONFIG_REPLACE_REGISTRY_HOST=always` when lockfiles come from elsewhere | Reproduced: a lockfile pointing at another host fails with `ECONNREFUSED`; the setting fixes it | Decided |
| P1-12, P1-29 | Where are packages installed during a publish? | On NFS/EFS / local disk + copy | **Local disk**; only `dist/`, `server.js`, package files go to the release | Builder code does this; no `node_modules` on shared storage, other VMs run releases without the registry | Decided |
| P1-9 | Where is npm's cache? | Default `~/.npm` / per-VM local dir | **Per VM, local disk** | npm's cache isn't built for several machines writing at once | Decided |
| P1-31 | Which packages must the registry hold? | Runtime only / + devDependencies / + native packages | **All three** | The builder runs `npm install --include=dev`; the build tools need their Linux native packages | Decided |
| P1-36 | Turn off npm's update check on the builders? | Leave / off | **Off** (`NPM_CONFIG_UPDATE_NOTIFIER=false` in `builder.env`) | Useless on VMs, noise in the registry log, fails offline. Set on both VMs (host 1 on 2026-11-13) | Decided |

## 3. Running it on AWS

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P2-2 | Which host runs the registry? | Host 1 / host 2 / new host | **Host 1** `i-0ca80950b15dcbfad` | The two hosts are identical; no new AWS resources | Decided |
| P2-3, P2-14 | Docker or native? | Docker Compose / native + systemd | **Native + systemd, its own Node v22.22.1** in `/opt/verdaccio/node` | Team chose no Docker on the hosts. Own Node because the host's Node is nvm under `ssm-user` (invisible to root) and changes with the builder's needs | Decided |
| P2-4 | Where is the data? | Host disk / new EBS volume / EFS | **Host disk** `/var/lib/verdaccio` | No new AWS resources; EFS is not used for registry work | Decided |
| P2-7, P2-8 | Address and protocol? | Private IP / DNS name; HTTP / HTTPS | **Private IP, plain HTTP** inside the VPC | Fine for the PoC; HTTPS is a must for the bank | Decided |
| P2-9 | How do we reach the hosts? | SSH / SSM | **SSM** Session Manager (+ port forwarding for the web UI) | Already working; no inbound ports needed | Decided |
| — | Network access to the registry | New security-group rule / existing rules | **Existing rule** (tcp 3000–9000 between the two hosts) | No change needed; not reachable from the internet (tested) | Decided |
| P2-10 | Backups? | None / `tar` on the host | **`tar` of data + config + unit**, mode 600 (contains `htpasswd`) | Restore drill passed. Off-host copy is still to do | Decided (off-host: open) |
| P2-13 | Logs? | journald / CloudWatch | **journald** (`journalctl -u verdaccio`) | Enough for the PoC | Decided |
| P2-15 | Keep Node v22 or move to v24? | v22 / v24 | **v22 for now** | Supported; Verdaccio only recommends v24. Move before the bank stage | Open |

## 4. Access and security

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P1-11, P1-18, P2-11 | Who can install and publish? | Open / login for publish / login for everything | **Anonymous install; login (`lab-admin`) only to publish; sign-up off** (`max_users: -1`) | Team: no authentication for the demo. Publish login prevents accidents. When auth comes, credentials go through the environment, never into generated code | Decided |
| P1-19 | Scope for internal packages? | `@lab` / other | **`@lab`** | Generic, free on npmjs. The bank's real scope is still to be agreed | Decided |
| P1-21 | Should internal scopes come from npmjs? | Yes / no | **No, never** | Prevents dependency confusion (a public package with our internal name replacing ours) | Decided |
| P1-22 | Stop internal packages being published to npmjs by mistake? | Env only / `publishConfig.registry` / both | **Both** | A terminal without the registry setting nearly published to npmjs once | Decided |

## 5. Offline mode and the seed tool

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P1-13 | Do the VMs have internet? | Yes / no / via proxy | **No** (bank) | Every package must come through the registry | Decided |
| P1-17, P1-34 | Does the registry itself reach npmjs in the bank? | Proxies npmjs / no link (pre-loaded only) | **No link** | Team: packages must already be present in the bank's registry; nothing is fetched from the public registry. Our registry replicates this since 2026-11-16 | Decided |
| P2-24 | How are packages loaded? | Publish tarballs / copy storage from an online registry / keep the old cache | **Load tarballs, scripted from an app's lockfile** (seed tool) | Closest to how a bank team adds packages; registry metadata only knows loaded versions | Decided |
| P2-25 | Where are packages downloaded? | Host 1 / laptop then transfer | **Host 1, by the seed tool only** | No file-transfer path from the laptop; the registry service itself keeps no link | Decided |
| P2-26 | Keep the old (online) storage or start empty? | Keep / start empty | **Start empty**, keep `@lab` + `.verdaccio-db.json`; old storage kept as `storage.online-20261116` | Old storage had version lists from npmjs without the files, which would cause false 404s. `.verdaccio-db.json` keeps existing tokens valid | Decided |
| P2-27 | First seed list? | `demo-app-1` lockfile / template lockfile | **`demo-app-1`'s lockfile**; the template lockfile once P1-30 is agreed | A real app's full dependency tree (204 packages: 157 Linux + 47 other platforms) | Decided |
| P2-28 | Forward `npm audit`? | Keep / off | **Off** | Nothing to forward to offline | Decided |
| P2-31 | What triggers loading? | Template change / inbox folder / builder pre-check / auto-fetch on 404 | **Inbox folder** on host 1 (systemd watcher) now; template change once P1-30 is agreed; builder pre-check only if P2-29 = any package | Not auto-fetch: that would rebuild the npmjs link | Decided |
| P2-32 | Check a blocklist before loading? | Yes / no | **Yes** (`/etc/verdaccio-seed/blocklist.txt`) | A blocked version should never enter the registry | Decided |
| — | Load native packages for every platform? | All / this platform only | **Linux x64 only** (both `-gnu` and `-musl`) | The VMs are Linux x64; `npm ci` needs both libc variants; other platforms' 404s are skipped by npm | Decided |
| — | Load with `npm publish`? | `npm publish` / own upload | **Own upload with the original file** | Some packages set `publishConfig.registry` to npmjs, which overrides `--registry`; changing the file would break lockfile integrity hashes | Decided |
| P2-29 | Can generated apps use any npm package, or only the template's set? | Fixed set / any package | — | Decides whether loading happens only on template changes or before every publish | **Open** (team) |
| P2-30 | How does the bank add a missing package? | Automatic / approval / security scan | PoC: load directly (`--load`) | If approval is needed, the seed tool's `--list-only` report goes to the approvers | **Open** (team) |

## 6. Versions and blocking

| ID | Question | Options | Chosen | Why | Status |
|---|---|---|---|---|---|
| P2-16 | Can the registry block vulnerable versions? | Verdaccio `package-filter` / community plugin / Artifactory Xray | **Verdaccio's built-in `package-filter`** to prove the mechanism | All 9 acceptance cases passed (2026-11-07). No rules active now; the seed blocklist covers loading | Decided |
| P2-18 | Hide blocked versions or replace them? | Hide / replace | **Hide** normally; `replace` for emergencies only | `replace` leaves lockfiles inconsistent | Decided |
| P2-19 | Quarantine new releases (`minAgeDays`)? | Off / on | **Off** (tested only) | It hides security fixes too; a policy decision for the bank | Decided |
| P2-20 | Where does the block list come from? | Manual / `npm audit` / Xray | **Manual** for the PoC | No CVE feed in Verdaccio; the bank: Xray / Curation (Q20) | Decided |
| P1-30 | Ship a pinned lockfile and use `npm ci`? | `npm install` each time / pinned lockfile + `npm ci` | — | Proposed to the builder owner: identical builds, reproducible rollbacks, and the lockfile is the seed list. Offline mode already limits drift to loaded versions | **Open** (builder owner) |
| P1-32 | Which Vite major does the generator pin? | Vite 5 / Vite 8 / unpinned | — | The major decides which native packages must be loaded. The current app uses Vite 5 | **Open** (builder owner) |

## 7. Bank stage (Phase 3)

| ID | Question | Status |
|---|---|---|
| P1-46 | Do we administer the bank's Artifactory, or only consume it? | **Open** |
| P1-38 | Which Artifactory version does the bank run? | **Open** |
| Q20 | How are vulnerable packages blocked in the bank (Xray / Curation)? | **Open** |
| — | HTTPS certificate, internal scope name, token or anonymous read | **Open**: ask the bank's Artifactory team |

## 8. Parked

| ID | Item | Why parked |
|---|---|---|
| P1-37 to P1-45 | Artifactory trial on the laptop (database, version, repos, blocking) | Step skipped; Verdaccio was enough for the PoC. Revisit only if the bank stage needs it |
