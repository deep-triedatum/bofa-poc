#!/usr/bin/env bash
# Run on EACH VM, as root, from the vm/ec2 directory (needs bootstrap.sh, builder.env.example, systemd/ beside it).
# Builds the builder from the clone on the shared volume (/mnt/shared/builder) into a LOCAL release folder.
#
# First time on a VM (does bootstrap, then install):
#   sudo EFS_ID=fs-0123456789abcdef0 AWS_REGION=ap-south-1 VM_NAME=vm1 ./setup-from-shared.sh
# Updates later (after `git pull` in /mnt/shared/builder), one VM at a time:
#   sudo ./setup-from-shared.sh
# Optional: SRC (default $MOUNT/builder), MOUNT (default /mnt/shared), PUBLIC_BASE_URL, VM_IP
set -euo pipefail

MOUNT="${MOUNT:-/mnt/shared}"
SRC="${SRC:-$MOUNT/builder}"
here="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

# 1. bootstrap, once per VM (it is safe to re-run, but not needed after the first time)
if [ ! -f /etc/builder/builder.env ] || [ ! -f /etc/systemd/system/builder.service ] || ! id builder >/dev/null 2>&1; then
  echo "== bootstrap (first run on this VM)"
  : "${EFS_ID:?first run: set EFS_ID, AWS_REGION and VM_NAME}"
  : "${AWS_REGION:?set AWS_REGION}"
  : "${VM_NAME:?set VM_NAME (different on every VM)}"
  MOUNT="$MOUNT" "$here/bootstrap.sh"
else
  mountpoint -q "$MOUNT" || { echo "$MOUNT is not mounted: sudo mount $MOUNT"; exit 1; }
fi

# 2. check the source
[ -d "$SRC" ] || { echo "$SRC not found: clone the builder there first"; exit 1; }
for f in package.json proxy/server.js reconciler/server.js; do
  [ -e "$SRC/$f" ] || { echo "$SRC/$f missing: is $SRC the root of the builder project?"; exit 1; }
done
command -v rsync >/dev/null || {
  if command -v apt-get >/dev/null; then apt-get install -y rsync; else dnf install -y rsync; fi
}

# 3. copy to a local release (node_modules and .next stay off EFS)
registry="$(sed -n 's/^NPM_REGISTRY=//p' /etc/builder/builder.env | tail -1)"
rev="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo nogit)"
name="builder-$rev-$(date +%Y%m%d%H%M%S)"
dir="/opt/builder/releases/$name"
echo "== copy $SRC -> $dir"
install -d -o builder -g builder "$dir"
rsync -a --exclude node_modules --exclude .next --exclude .git --exclude .shared --exclude .swc "$SRC"/ "$dir"/
chown -R builder:builder "$dir"

run() { sudo -u builder env HOME=/home/builder NEXT_TELEMETRY_DISABLED=1 ${registry:+npm_config_registry="$registry"} "$@"; }
echo "== npm install"
( cd "$dir" && run npm install --legacy-peer-deps --no-audit --no-fund )
echo "== build"
( cd "$dir" && run node_modules/.bin/next build )

# 4. switch and restart (published apps keep running: KillMode=process)
echo "== switch to $name and restart"
ln -sfn "$dir" /opt/builder/current
systemctl restart builder proxy reconciler

# keep the three newest releases
ls -1dt /opt/builder/releases/*/ | tail -n +4 | xargs -r rm -rf

# 5. check
echo "== check"
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8080/_proxy/health && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/_proxy/health >/dev/null && echo "proxy ok" || echo "proxy NOT answering: journalctl -u proxy -n 50"
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
[ "$code" = 200 ] && echo "editor ok (through the proxy)" || echo "editor answered $code: journalctl -u builder -n 50"
systemctl is-active builder proxy reconciler
echo "VMs seen on the shared volume: $(ls "$MOUNT/vms" 2>/dev/null | tr '\n' ' ')"
