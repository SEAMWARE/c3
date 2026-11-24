#!/usr/bin/env bash
#
# httpServerChoice.sh - Compile's HTTP server choice reaches coraine-build: POST /api/builds/command (nothing run)
# takes httpServer mhd (the default, left out of the command), builtin, or both (--http-server both: the broker
# carries both and picks one at start); anything else is a 400; with pgo / tune only mhd (422: coraine-build
# trains with libmicrohttpd alone); and PUT /api/compile/choice keeps both in the configuration.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/httpServerChoice.sh [<c3 binary>]     default ./c3; port 7915 (C3_TEST_PORT_E)
#
# Exit 0 and "httpServerChoice: ok", or 1 and what failed.
#
set -u
C3=${1:-./c3}
P=${C3_TEST_PORT_E:-7915}
DIR=$(mktemp -d)
pid=

finish() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

"$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$P/" && break; sleep 0.1; done

rc=0
post() { curl -s -o "$DIR/body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$1" "http://127.0.0.1:$P/api/builds/command"; }

# expect <body> <status> <python check on the answer, or ''> <what>
expect() {
  local got; got=$(post "$1")
  if [ "$got" != "$2" ]; then echo "httpServerChoice: $4: HTTP $got, not $2: $(head -c 300 "$DIR/body")"; rc=1; return; fi
  [ -z "$3" ] && return
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); a=d['argv']; sys.exit(0 if ($3) else 1)" "$DIR/body" \
    || { echo "httpServerChoice: $4: $(head -c 400 "$DIR/body")"; rc=1; }
}

expect '{"mode":"release","features":{}}'                         200 "'--http-server' not in a"                                       'mhd by default, left out'
expect '{"mode":"release","features":{},"httpServer":"mhd"}'      200 "'--http-server' not in a"                                       'mhd, left out'
expect '{"mode":"release","features":{},"httpServer":"builtin"}'  200 "a[a.index('--http-server')+1] == 'builtin'"                    'builtin'
expect '{"mode":"release","features":{},"httpServer":"both"}'     200 "a[a.index('--http-server')+1] == 'both'"                       'both'
expect '{"mode":"release","features":{},"httpServer":"apache"}'   400 ''                                                              'an unknown server'
expect '{"mode":"pgo","features":{},"httpServer":"both"}'         422 ''                                                              'both with pgo'
expect '{"mode":"tune","workload":"/tmp/w.json","features":{},"httpServer":"builtin"}' 422 ''                                         'builtin with tune'

#
# The choice kept: PUT /api/compile/choice takes both, and the configuration file holds it
#
got=$(curl -s -o "$DIR/body" -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
      -d '{"mode":"release","httpServer":"both","features":{},"bridges":{},"workload":""}' "http://127.0.0.1:$P/api/compile/choice")
if [ "$got" != 200 ] && [ "$got" != 204 ]; then echo "httpServerChoice: PUT choice both: HTTP $got: $(head -c 300 "$DIR/body")"; rc=1
elif ! python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))['compile']['choice']['httpServer'] == 'both' else 1)" "$DIR/c3.json"; then
  echo "httpServerChoice: PUT choice both: not in $DIR/c3.json"; rc=1
fi
got=$(curl -s -o "$DIR/body" -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
      -d '{"mode":"release","httpServer":"apache","features":{},"bridges":{},"workload":""}' "http://127.0.0.1:$P/api/compile/choice")
[ "$got" = 400 ] || { echo "httpServerChoice: PUT choice apache: HTTP $got, not 400"; rc=1; }

[ $rc = 0 ] && echo "httpServerChoice: ok" || cat "$DIR/c3.log"
exit $rc
