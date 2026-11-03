#!/usr/bin/env bash
# End-to-end check of the compose stack. Run after `docker compose up -d --build`.
#   1. publish two apps through the load balancer
#   2. open each through the load balancer repeatedly (requests land on both VMs)
#   3. stop the VM that runs the first app and wait for the other VM to adopt it
#   4. start the stopped VM again
set -uo pipefail
cd "$(dirname "$0")/.."

LB=${LB:-http://localhost:8080}
fail=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fail=1; }

body() {
  echo "{\"appId\":\"$1\",\"ait\":\"ait-1\",\"components\":{\"root\":{\"id\":\"root\",\"parent\":\"root\",\"type\":\"Box\",\"children\":[\"c\"],\"props\":{}},\"c\":{\"id\":\"c\",\"parent\":\"root\",\"type\":\"Text\",\"children\":[],\"props\":{\"children\":\"Hello from $1\"}}}}"
}

# registry field of an app, read through a given VM container
entry() { docker compose exec -T "$1" node -e "const e=require('/shared/registry/$2.json');console.log(e.$3)"; }

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$LB/apps/$1/"; }

echo "== waiting for the load balancer"
for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "$LB/" && break; sleep 2; done

echo "== publishing (takes a while: npm install + build)"
for app in smoke-one smoke-two; do
  out=$(curl -s --max-time 600 -X POST "$LB/api/publish" -H 'content-type: application/json' -d "$(body $app)")
  if echo "$out" | grep -q '"release"'; then
    ok "$app published: $(echo "$out" | grep -o '"url":"[^"]*"')"
  else
    bad "$app publish failed: $out"
  fi
done

echo "== which VM runs what"
for app in smoke-one smoke-two; do
  echo "  $app -> $(entry vm1 $app vm) port $(entry vm1 $app port)"
done

echo "== opening each app through the load balancer (6 requests each)"
for app in smoke-one smoke-two; do
  codes=$(for _ in $(seq 1 6); do status $app; echo -n ' '; done)
  [ "$(echo $codes | tr ' ' '\n' | sort -u)" = "200" ] && ok "$app: $codes" || bad "$app: $codes"
done

echo "== stopping the VM that runs smoke-one"
owner=$(entry vm1 smoke-one vm)
other=$([ "$owner" = vm1 ] && echo vm2 || echo vm1)
docker compose stop "$owner" >/dev/null 2>&1
echo "  stopped $owner, waiting for $other to adopt (heartbeat timeout is 10 s)"
adopted=""
for _ in $(seq 1 40); do
  now=$(entry "$other" smoke-one vm 2>/dev/null || true)
  if [ "$now" = "$other" ] && [ "$(status smoke-one)" = "200" ]; then adopted=yes; break; fi
  sleep 2
done
[ -n "$adopted" ] && ok "smoke-one now runs on $other and answers at the same URL" || bad "smoke-one was not adopted by $other"
[ "$(status smoke-two)" = "200" ] && ok "smoke-two still answers" || echo "  note  smoke-two answers $(status smoke-two) (it may also have been on $owner)"

echo "== starting $owner again"
docker compose start "$owner" >/dev/null 2>&1
for _ in $(seq 1 30); do
  [ "$(docker compose ps --format '{{.Health}}' "$owner" 2>/dev/null)" = "healthy" ] && break; sleep 2
done
[ "$(status smoke-one)" = "200" ] && ok "smoke-one still answers" || bad "smoke-one does not answer"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
