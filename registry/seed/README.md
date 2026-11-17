# Seed tool: load packages into an offline registry

When the registry has **no uplink** (no link to the public npm registry), every package must be loaded before anyone installs it. Doing that by hand does not scale, so this tool does it from a `package.json` or `package-lock.json`.

Only this tool talks to the public registry. The registry service itself stays offline.

## What it does

1. Takes a `package.json` (resolves a lockfile from it, installs nothing) or a `package-lock.json`.
2. Lists every `name@version`. Skips internal scopes (`INTERNAL_SCOPES`) and native packages for other platforms (`SEED_OS` / `SEED_CPU`).
3. Asks the registry what it already has. **Present packages are skipped**, so reruns are cheap.
4. Refuses the whole input if a package is in `blocklist.txt` or is not a registry package (git, file or URL).
5. `--load`: downloads each missing tarball from the public registry and uploads it **unchanged** to the registry.
   `--list-only`: only writes the missing list, for an approval process.
6. Checks the whole lockfile against the registry, including integrity hashes, and writes a report.

## Files

| File | Installed to | Purpose |
|---|---|---|
| `seed-registry.sh` | `/opt/verdaccio-seed/` | Main script |
| `seed-plan.js` | `/opt/verdaccio-seed/` | Helper: plan, verify, publish |
| `seed.env` | `/etc/verdaccio-seed/` | Settings (replace `REGISTRY_HOST`) |
| `blocklist.txt` | `/etc/verdaccio-seed/` | Versions never loaded |
| `verdaccio-seed-inbox.path` | `/etc/systemd/system/` | Watches the inbox |
| `verdaccio-seed-inbox.service` | `/etc/systemd/system/` | Runs the script for files in the inbox |
| (token) | `/etc/verdaccio-seed/npmrc` | `//REGISTRY_HOST:4873/:_authToken=...`, mode 600 |

Work folders are in `/var/lib/verdaccio-seed/`: `inbox/`, `done/`, `failed/`, `reports/`, `work/`.

## Install (on the registry VM)

```bash
sudo useradd --system --home-dir /var/lib/verdaccio-seed --shell /sbin/nologin verdaccio-seed
sudo install -d -o verdaccio-seed -g verdaccio-seed -m 750 /var/lib/verdaccio-seed
sudo install -d -m 755 /opt/verdaccio-seed
sudo install -d -m 750 -g verdaccio-seed /etc/verdaccio-seed

# in the folder holding the 6 files (check them with sha256sum first)
sudo install -m 755 seed-registry.sh seed-plan.js /opt/verdaccio-seed/
sudo install -m 644 verdaccio-seed-inbox.path verdaccio-seed-inbox.service /etc/systemd/system/
sed 's#REGISTRY_HOST#172.31.47.239#' seed.env > seed.env.local
sudo install -m 640 -g verdaccio-seed seed.env.local /etc/verdaccio-seed/seed.env
sudo install -m 640 -g verdaccio-seed blocklist.txt /etc/verdaccio-seed/
sudo install -m 600 -o verdaccio-seed -g verdaccio-seed ~/.npmrc-registry /etc/verdaccio-seed/npmrc   # admin token

# checks: token works, smoke test, then the trigger
sudo -u verdaccio-seed /opt/verdaccio/node/bin/npm whoami --registry=http://172.31.47.239:4873/ --userconfig=/etc/verdaccio-seed/npmrc --cache /var/lib/verdaccio-seed/npm-cache
sudo -u verdaccio-seed /opt/verdaccio-seed/seed-registry.sh --list-only package-lock.json
sudo systemctl daemon-reload && sudo systemctl enable --now verdaccio-seed-inbox.path
```

**No file-transfer path to the VM?** Pack the 6 files on your machine and paste them as text:
```bash
# your machine
tar -czf - seed-registry.sh seed-plan.js seed.env blocklist.txt verdaccio-seed-inbox.path verdaccio-seed-inbox.service | base64 -w 76 > seed-tool.b64
sha256sum seed-tool.b64
# VM: paste the file's content into  cat > seed-tool.b64 <<'EOF' ... EOF,
# compare sha256sum, then:  base64 -d seed-tool.b64 | tar -xzf -   and check each file's sha256sum
```

## Use

```bash
# Automatic: drop a file in the inbox (copy as .part first, then rename, so it is never read half-written)
sudo install -m 644 package-lock.json /var/lib/verdaccio-seed/inbox/myapp.part
sudo mv /var/lib/verdaccio-seed/inbox/myapp.part /var/lib/verdaccio-seed/inbox/myapp.json
journalctl -u verdaccio-seed-inbox.service -f        # watch it run
ls /var/lib/verdaccio-seed/{done,failed,reports}     # result

# By hand
sudo -u verdaccio-seed /opt/verdaccio-seed/seed-registry.sh --list-only package-lock.json
sudo -u verdaccio-seed /opt/verdaccio-seed/seed-registry.sh --load      package-lock.json
```

Exit codes: `0` all present, `1` error or failures, `2` list-only found missing packages, `3` blocked or unsupported.

## Why it does not use `npm publish`

Some packages ship `publishConfig.registry` set to the public registry (for example `rolldown`, `@napi-rs/wasm-runtime`). That **overrides** `--registry`, so `npm publish` sends them to the public registry. Without a public token it fails, so it is safe, but the package can never be loaded. Changing the tarball would change its integrity hash and break `npm ci`. The tool therefore sends the same request body `npm publish` builds (libnpmpublish) itself, with the original tarball bytes.

## Notes

- **Tags:** only the highest version moves `latest`. Older versions get `seed-old` and prereleases `seed-pre`, so loading an old version never downgrades `latest`.
- **Body size:** the upload is base64 (about 1.35× the tarball). Native binaries are about 9 MB, so the registry needs `max_body_size` well above 12 MB (the lab uses `100mb`).
- **Platforms:** with `SEED_OS=linux` and `SEED_CPU=x64`, both `-gnu` and `-musl` natives are loaded (`npm ci` installs both), but not macOS, Windows or ARM ones.
- **Blocklist vs registry filters:** keep `blocklist.txt` in line with any registry-side block rules, so a blocked version is refused here instead of being loaded and then hidden.

## Tested on a cloud VM (Verdaccio 6.11.1, offline registry, Step 11)

| Test | Result |
|---|---|
| `--list-only`, real app's lockfile (React 18, Vite 5, UI library), registry still online | 204 packages: 157 present, 47 other-platform skipped, exit 0 |
| Inbox trigger with an already-present package | Picked up within seconds, file moved to `done/` |
| After switching offline: preview | 157 missing, exit 2 |
| Load through the inbox | **157 loaded and verified in ~2 min** |
| Same file again | Nothing loaded |
| Blocklisted `lodash@4.17.20` | Refused, exit 3 |
| Other VM: `npm ci` + build, `npm install` without lockfile | Both work from the registry alone; registry made **0** requests to npmjs |
| Real publishes through the app generator | OK on both VMs |

npm also asks for the skipped other-platform packages when installing **without** a lockfile; the registry answers `404` and npm skips them, because they're optional. Those 404 lines in the registry log are expected.

## Tested (laptop, Verdaccio 6.11.1, no uplink)

| Test | Result |
|---|---|
| `--list-only` with a `package.json` (react, react-dom, is-number) | 4 missing listed, nothing loaded, exit 2 |
| `--load` same file | 4 loaded, integrity verified, exit 0 |
| Rerun | "everything already in the registry", exit 0 |
| Older version (`is-number@6.0.0` after 7.0.0) | Loaded as `seed-old`; `latest` stays 7.0.0 |
| Blocklisted `lodash@4.17.20` | Refused, nothing loaded, exit 3 |
| Vite 8 + React lockfile through the inbox | 27 loaded, 24 other-platform natives skipped, file moved to `done/` |
| `npm ci` from an empty cache, then `vite build` | 21 packages, build OK, **0** requests to the public registry |
| A package that was never loaded (`dayjs`) | `E404 no such package available` |
