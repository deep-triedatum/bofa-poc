#!/bin/bash
# One "VM": editor + proxy + reconciler. If any of them exits, the container exits so Docker can restart it.
set -e

mkdir -p "${SHARED_DIR:-/shared}"

node_modules/.bin/next start -p 3000 &
pids="$!"
node proxy/server.js &
pids="$pids $!"
node reconciler/server.js &
pids="$pids $!"

# stopping the container stops these; published apps are detached and stop with the container
stop() { kill $pids 2>/dev/null || true; }
trap stop TERM INT

# `|| status=$?` keeps `set -e` from exiting here, before the cleanup below
status=0
wait -n || status=$?
stop
exit $status
