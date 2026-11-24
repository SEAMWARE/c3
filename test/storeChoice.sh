#!/usr/bin/env bash
#
# storeChoice.sh - Compile's current-state stores reach coraine-build: POST /api/builds/command (nothing run) passes
# CORDB and MONGOC as any switch (--features CORDB=OFF); one of them at least (422 for neither); corDB with pgo / tune,
# their training running the broker on corDB (422 without it).
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/storeChoice.sh [<c3 binary>]     default ./c3; port 7916 (C3_TEST_PORT_F)
#
# Exit 0 and "storeChoice: ok", or 1 and what failed.
#
set -u
C3=${1:-./c3}
P=${C3_TEST_PORT_F:-7916}
DIR=$(mktemp -d)
pid=

finish() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

"$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$P/" && break; sleep 0.1; done

rc=0
# expect <body> <status> <check> <what> [trains]
#   200: <check> a python expression on the command's argv (a; f the --features value), or ''
#   4xx: <check> text the refusal's detail holds - the reason, not only the status
#   trains: the case needs a machine that can train (curl, wrk, python3); on one that cannot, the 422 saying so is
#           noted and the case passes - its reason is the machine's
expect() {
  local got; got=$(curl -s -o "$DIR/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "http://127.0.0.1:$P/api/builds/command")
  if [ "${5:-}" = trains ] && [ "$got" = 422 ] && grep -q 'training needs' "$DIR/body"; then
    echo "storeChoice: $4: this machine cannot train ($(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['detail'])" "$DIR/body")) - noted"; return
  fi
  if [ "$got" != "$2" ]; then echo "storeChoice: $4: HTTP $got, not $2: $(head -c 300 "$DIR/body")"; rc=1; return; fi
  [ -z "$3" ] && return
  if [ "$got" = 200 ]; then
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); a=d['argv']; f=a[a.index('--features')+1] if '--features' in a else ''; sys.exit(0 if ($3) else 1)" "$DIR/body" \
      || { echo "storeChoice: $4: $(head -c 400 "$DIR/body")"; rc=1; }
  elif ! grep -q -F -- "$3" "$DIR/body"; then
    echo "storeChoice: $4: HTTP $got, but not for '$3': $(head -c 300 "$DIR/body")"; rc=1
  fi
}

expect '{"mode":"release","features":{"CORDB":false}}'                        200 "'CORDB=OFF' in f.split(',')"   'mongoc only: CORDB=OFF passed'
expect '{"mode":"release","features":{"MONGOC":false}}'                       200 "'MONGOC=OFF' in f.split(',')"  'corDB only: MONGOC=OFF passed'
expect '{"mode":"release","features":{"CORDB":false,"MONGOC":false}}'         422 'no current-state store'        'neither store'
expect '{"mode":"pgo","features":{"CORDB":false}}'                            422 'CORDB off: not with --pgo'     'pgo without corDB'
echo '{}' > "$DIR/w.json"
expect '{"mode":"tune","workload":"'"$DIR"'/w.json","features":{"CORDB":false}}'  422 'CORDB off: not with --tune'  'tune without corDB'
expect '{"mode":"pgo","features":{"MONGOC":false}}'                           200 ''                              'pgo with corDB only'   trains

[ $rc = 0 ] && echo "storeChoice: ok" || cat "$DIR/c3.log"
exit $rc
