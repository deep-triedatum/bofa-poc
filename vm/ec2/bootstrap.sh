#!/usr/bin/env bash
# Run once on EACH VM, as root, from this directory:
#   sudo EFS_ID=fs-0123456789abcdef0 AWS_REGION=ap-south-1 VM_NAME=vm1 ./bootstrap.sh
# Optional: VM_IP (default: this instance's private IP), PUBLIC_BASE_URL, MOUNT=/mnt/shared
# Safe to run again: it does not touch existing files in the shared volume.
set -euo pipefail

: "${EFS_ID:?set EFS_ID, e.g. fs-0123456789abcdef0}"
: "${AWS_REGION:?set AWS_REGION, e.g. ap-south-1}"
: "${VM_NAME:?set VM_NAME, different on every VM, e.g. vm1}"
MOUNT="${MOUNT:-/mnt/shared}"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"

# the numeric ids must be the same on every VM: files on the shared volume are owned by number
SVC_UID=1500; SVC_GID=1500

echo "== packages"
if command -v apt-get >/dev/null; then
  apt-get update -y && apt-get install -y nfs-common curl ca-certificates
  PM=apt
elif command -v dnf >/dev/null; then
  dnf install -y nfs-utils curl
  PM=dnf
else
  echo "needs apt or dnf"; exit 1
fi

echo "== node"
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if [ "$(node_major || echo 0)" -lt 20 ]; then
  # downloads from nodesource.com: if the VM cannot reach it, install Node 20+ from your own mirror and re-run
  if [ "$PM" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs
  fi
fi
echo "node $(node -v), npm $(npm -v)"

echo "== service user (uid $SVC_UID)"
getent group builder >/dev/null || groupadd -g "$SVC_GID" builder
id builder >/dev/null 2>&1 || useradd -u "$SVC_UID" -g "$SVC_GID" -m -s /usr/sbin/nologin builder
[ "$(id -u builder)" = "$SVC_UID" ] || echo "WARNING: builder has uid $(id -u builder), not $SVC_UID. It must match on every VM."

echo "== efs mount at $MOUNT"
mkdir -p "$MOUNT"
fstab="${EFS_ID}.efs.${AWS_REGION}.amazonaws.com:/ $MOUNT nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0"
grep -q " $MOUNT " /etc/fstab || echo "$fstab" >> /etc/fstab
mountpoint -q "$MOUNT" || mount "$MOUNT" || {
  echo "mount failed. Check: security group allows TCP 2049 from this VM, a mount target exists in this AZ, VPC DNS is on."
  exit 1
}
# only the top level: never recurse over what other VMs have written
install -d -o builder -g builder -m 0775 "$MOUNT"
for d in apps registry vms env; do install -d -o builder -g builder -m 0775 "$MOUNT/$d"; done
sudo -u builder touch "$MOUNT/.write-test-$VM_NAME" && rm -f "$MOUNT/.write-test-$VM_NAME" \
  || { echo "builder cannot write to $MOUNT: check ownership and that the uid matches on the other VM"; exit 1; }

echo "== settings"
install -d -m 0755 /etc/builder
if [ -f /etc/builder/builder.env ]; then
  echo "/etc/builder/builder.env exists, keeping it"
else
  token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  VM_IP="${VM_IP:-$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || true)}"
  : "${VM_IP:?could not read the private IP from instance metadata: set VM_IP}"
  sed -e "s|__VM_NAME__|$VM_NAME|g" -e "s|__VM_IP__|$VM_IP|g" "$here/builder.env.example" > /etc/builder/builder.env
  [ -n "${PUBLIC_BASE_URL:-}" ] && sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$PUBLIC_BASE_URL|" /etc/builder/builder.env
  sed -i "s|^SHARED_DIR=.*|SHARED_DIR=$MOUNT|" /etc/builder/builder.env
  chmod 0640 /etc/builder/builder.env; chgrp builder /etc/builder/builder.env
  echo "wrote /etc/builder/builder.env (VM_NAME=$VM_NAME VM_IP=$VM_IP)"
fi
install -d -o builder -g builder -m 0755 /opt/builder /var/tmp/builder-builds

echo "== services"
for u in builder proxy reconciler; do install -m 0644 "$here/systemd/$u.service" "/etc/systemd/system/$u.service"; done
systemctl daemon-reload
systemctl enable builder proxy reconciler >/dev/null

echo
echo "bootstrap done on $VM_NAME. Next: copy the package here and run install-app.sh"
