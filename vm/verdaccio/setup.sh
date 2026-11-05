#!/bin/bash
# Installs Verdaccio as a systemd service on THIS VM. Run as root, from this directory.
# Then set NPM_REGISTRY=http://<this-vm-ip>:4873/ in the builder's environment on every VM.
set -euo pipefail

command -v node >/dev/null || { echo "node is required (18 or newer)"; exit 1; }

id verdaccio >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin verdaccio
npm install -g verdaccio@5

mkdir -p /etc/verdaccio /var/lib/verdaccio/storage
# keep an edited config on re-runs
[ -f /etc/verdaccio/config.yaml ] || install -m 0644 config.yaml /etc/verdaccio/config.yaml
chown -R verdaccio: /var/lib/verdaccio

# the unit calls `env verdaccio`, so it must be on the default PATH
command -v verdaccio >/dev/null && ln -sf "$(command -v verdaccio)" /usr/local/bin/verdaccio

install -m 0644 verdaccio.service /etc/systemd/system/verdaccio.service
systemctl daemon-reload
systemctl enable --now verdaccio

sleep 2
curl -fsS http://127.0.0.1:4873/-/ping && echo " verdaccio is up on :4873"
