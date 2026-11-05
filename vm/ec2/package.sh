#!/usr/bin/env bash
# Run on your machine: packs the builder source (no node_modules, no build output) for the VMs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../builder"
[ -d "$src" ] || { echo "builder directory not found at $src"; exit 1; }

version="$(git -C "$src" describe --tags --always --dirty 2>/dev/null || date +%Y%m%d%H%M%S)"
mkdir -p "$here/dist"
out="$here/dist/builder-$version.tgz"

tar -C "$src" \
  --exclude=node_modules --exclude=.next --exclude=.git --exclude=.shared --exclude=.swc \
  -czf "$out" .
echo "$out"
echo "copy it to each VM, then run install-app.sh there"
