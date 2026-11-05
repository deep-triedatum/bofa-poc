#!/usr/bin/env bash
# Run on EACH VM, as root, to install or update the builder from a package made by package.sh:
#   sudo ./install-app.sh /tmp/builder-<version>.tgz
# Keeps the last 3 releases in /opt/builder/releases; /opt/builder/current points at the active one.
set -euo pipefail

pkg="${1:?usage: install-app.sh /path/to/builder-<version>.tgz}"
[ -f "$pkg" ] || { echo "$pkg not found"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
id builder >/dev/null 2>&1 || { echo "run bootstrap.sh first"; exit 1; }

name="$(basename "$pkg" .tgz)-$(date +%Y%m%d%H%M%S)"
dir="/opt/builder/releases/$name"
install -d -o builder -g builder "$dir"
tar -xzf "$pkg" -C "$dir"
chown -R builder:builder "$dir"

# the registry the build uses, if /etc/builder/builder.env sets one
registry="$(sed -n 's/^NPM_REGISTRY=//p' /etc/builder/builder.env | tail -1)"
run() { sudo -u builder env HOME=/home/builder NEXT_TELEMETRY_DISABLED=1 ${registry:+npm_config_registry="$registry"} "$@"; }

echo "== npm install ($name)"
( cd "$dir" && run npm install --legacy-peer-deps --no-audit --no-fund )
echo "== build"
( cd "$dir" && run node_modules/.bin/next build )

echo "== switch to the new release and restart"
ln -sfn "$dir" /opt/builder/current
systemctl restart builder proxy reconciler
# apps already published keep running: they are not children of the services' control group

# keep the three newest releases
ls -1dt /opt/builder/releases/*/ | tail -n +4 | xargs -r rm -rf

echo "== check"
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8080/_proxy/health && break; sleep 1; done
curl -fsS http://127.0.0.1:8080/_proxy/health >/dev/null && echo "proxy ok" || echo "proxy NOT answering: journalctl -u proxy -n 50"
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)"
[ "$code" = 200 ] && echo "editor ok (through the proxy)" || echo "editor answered $code: journalctl -u builder -n 50"
systemctl is-active builder proxy reconciler
