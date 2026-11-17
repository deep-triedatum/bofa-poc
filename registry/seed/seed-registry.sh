#!/usr/bin/env bash
# seed-registry.sh: load missing npm packages into an offline (no-uplink) registry.
#
#   seed-registry.sh --load      <package.json | package-lock.json>   download missing packages and publish them
#   seed-registry.sh --list-only <package.json | package-lock.json>   only report what is missing (for approval)
#   seed-registry.sh --inbox                                          process every *.json in the inbox (systemd)
#
# Only this script talks to the public registry; the registry itself has no uplink.
# Safe to rerun: packages already in the registry are skipped.
# Exit codes: 0 all present, 1 error or failures, 2 list-only found missing packages, 3 blocked/unsupported.

set -uo pipefail

CONF=${SEED_CONF:-/etc/verdaccio-seed/seed.env}
# shellcheck source=/dev/null
. "$CONF" || { echo "cannot read $CONF" >&2; exit 1; }
: "${REGISTRY_URL:?}" "${UPSTREAM_URL:?}" "${AUTH_NPMRC:?}" "${NODE_BIN:?}" "${SEED_HOME:?}"
export PATH="$NODE_BIN:/usr/bin:/bin"
export REGISTRY_URL INTERNAL_SCOPES="${INTERNAL_SCOPES:-}" BLOCKLIST="${BLOCKLIST:-}"
export SEED_OS="${SEED_OS:-}" SEED_CPU="${SEED_CPU:-}" AUTH_NPMRC
export SEMVER_PATH="${SEMVER_PATH:-$NODE_BIN/../lib/node_modules/npm/node_modules/semver}"
PLAN="$(dirname "$(readlink -f "$0")")/seed-plan.js"
NPM_OPTS=(--cache "$SEED_HOME/npm-cache" --no-audit --no-fund --no-update-notifier)

usage() { sed -n '4,6p' "$0" | sed 's/^# *//' >&2; exit 64; }

count() { awk -F'\t' -v s="$1" '$1 == s { c++ } END { print c + 0 }' "$2"; }

# seed_one <load|list-only> <file>: process one package.json or package-lock.json
seed_one() {
  local mode=$1 input stamp work report kind rc=0
  input=$(readlink -f "$2")
  stamp=$(date +%Y%m%d-%H%M%S)
  work=$(mktemp -d "$SEED_HOME/work/$stamp-XXXX") || return 1
  mkdir -p "$work/tgz"
  report="$SEED_HOME/reports/$stamp-$(basename "$input" .json).txt"
  say() { echo "$*" | tee -a "$report"; }

  say "seed-registry  mode=$mode  input=$input"
  say "registry=$REGISTRY_URL  upstream=$UPSTREAM_URL  $(date -Is)"

  # 1. Get a lockfile: use it as is, or resolve one from package.json against the public registry.
  kind=$(node "$PLAN" kind "$input" 2>>"$report") || { say "ERROR: not valid JSON"; return 1; }
  if [ "$kind" = lock ]; then
    cp "$input" "$work/package-lock.json"
  else
    cp "$input" "$work/package.json"
    local scope_opts=() s
    for s in ${INTERNAL_SCOPES//,/ }; do scope_opts+=("--$s:registry=$REGISTRY_URL"); done
    say "resolving dependency tree from package.json (nothing is installed)"
    (cd "$work" && npm install --package-lock-only --ignore-scripts --registry="$UPSTREAM_URL" \
        --userconfig=/dev/null "${scope_opts[@]}" "${NPM_OPTS[@]}") >>"$work/npm.log" 2>&1 \
      || { say "ERROR: could not resolve dependencies, see $work/npm.log"; return 1; }
  fi

  # 2. Compare with the registry.
  node "$PLAN" plan "$work/package-lock.json" >"$work/plan.tsv" 2>>"$report" \
    || { say "ERROR: could not read the registry (is it running?)"; return 1; }
  local total present missing blocked unsupported skipped
  total=$(wc -l <"$work/plan.tsv"); skipped=$(count SKIPPED "$work/plan.tsv")
  present=$(count PRESENT "$work/plan.tsv"); missing=$(count MISSING "$work/plan.tsv")
  blocked=$(count BLOCKED "$work/plan.tsv"); unsupported=$(count UNSUPPORTED "$work/plan.tsv")
  say "packages=$total  present=$present  missing=$missing  blocked=$blocked  unsupported=$unsupported  skipped(other platforms)=$skipped"
  grep -E '^(MISSING|BLOCKED|UNSUPPORTED)' "$work/plan.tsv" | tee -a "$report"

  if [ "$blocked" -gt 0 ] || [ "$unsupported" -gt 0 ]; then
    say "RESULT: refused, blocked or unsupported packages (nothing loaded)"; return 3
  fi
  if [ "$missing" -eq 0 ]; then
    say "RESULT: everything already in the registry"; rm -rf "$work"; return 0
  fi
  if [ "$mode" = list-only ]; then
    say "RESULT: $missing missing (list-only, nothing loaded)"; rm -rf "$work"; return 2
  fi

  # 3. Download each missing package from the public registry and publish it to ours.
  local status spec tag tgz
  while IFS=$'\t' read -r status spec tag; do
    [ "$status" = MISSING ] || continue
    if tgz=$(cd "$work/tgz" && npm pack "$spec" --silent --registry="$UPSTREAM_URL" \
                 --userconfig=/dev/null "${NPM_OPTS[@]}" 2>>"$work/npm.log" | tail -n 1) \
       && [ -f "$work/tgz/$tgz" ] \
       && node "$PLAN" publish "$work/tgz/$tgz" "$tag" >>"$work/npm.log" 2>&1; then
      say "LOADED  $spec  ($tag)"
    else
      say "FAILED  $spec  (see $work/npm.log)"
    fi
  done <"$work/plan.tsv"

  # 4. Verify the whole lockfile against the registry, including integrity hashes.
  node "$PLAN" verify "$work/package-lock.json" >"$work/verify.tsv" 2>>"$report" \
    || { say "ERROR: verify could not read the registry"; return 1; }
  local ok bad
  ok=$(count OK "$work/verify.tsv"); bad=$(grep -cvE '^OK' "$work/verify.tsv")
  grep -vE '^OK' "$work/verify.tsv" | tee -a "$report"
  if [ "$bad" -eq 0 ]; then
    say "RESULT: OK, $ok packages verified ($missing loaded)"; rm -rf "$work"
  else
    say "RESULT: FAILED, $bad not OK; work files kept in $work"; rc=1
  fi
  return $rc
}

# Process every *.json in the inbox, then move it to done/ or failed/.
process_inbox() {
  local f rc dest
  sleep "${INBOX_SETTLE_SECONDS:-2}"   # let a file being copied finish
  for f in "$SEED_HOME"/inbox/*.json; do
    [ -e "$f" ] || continue
    rc=0; seed_one "${SEED_MODE:-load}" "$f" || rc=$?
    case $rc in 0|2) dest=done ;; *) dest=failed ;; esac
    mv "$f" "$SEED_HOME/$dest/$(date +%Y%m%d-%H%M%S)-$(basename "$f")"
    echo "$(basename "$f") -> $dest (exit $rc)"
  done
  return 0   # never fail the unit, so the path unit keeps watching
}

mkdir -p "$SEED_HOME"/{inbox,done,failed,reports,work,npm-cache} || exit 1
exec 9>"$SEED_HOME/.lock" && flock 9   # one run at a time (manual runs wait for the service and vice versa)

case "${1:-}" in
  --inbox)            process_inbox ;;
  --load|--list-only) [ -f "${2:-}" ] || usage; seed_one "${1#--}" "$2" ;;
  *)                  usage ;;
esac
