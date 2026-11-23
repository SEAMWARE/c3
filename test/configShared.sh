#!/usr/bin/env bash
#
# configShared.sh - two c3 on one configuration file: a change made through one is not lost by a change made
# through the other (each reads the file again when it changed on disk, config.c cfgFresh)
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/configShared.sh [<c3 binary>]     default ./c3; ports 7911 and 7912 (C3_TEST_PORT_A, C3_TEST_PORT_B)
#
# Exit 0 and "configShared: ok", or 1 and what was lost.
#
set -u
C3=${1:-./c3}
A=${C3_TEST_PORT_A:-7911}
B=${C3_TEST_PORT_B:-7912}
DIR=$(mktemp -d)
CFG=$DIR/c3.json
pids=()

finish() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

start() {
  "$C3" --port "$1" --no-browser --config "$CFG" > "$DIR/c3-$1.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 1 50); do curl -sf -o /dev/null "http://127.0.0.1:$1/api/ui" 2>/dev/null && return 0; curl -s -o /dev/null "http://127.0.0.1:$1/" && return 0; sleep 0.1; done
  echo "configShared: c3 on port $1 did not start - $DIR/c3-$1.log"; cat "$DIR/c3-$1.log"; exit 1
}

put() { curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -d "$2" "http://127.0.0.1:$1$3"; }

start "$A"
start "$B"

rc=0
[ "$(put "$A" '{"lang": "es"}'      /api/ui)" = 200 ] || { echo "configShared: PUT /api/ui lang on $A failed"; rc=1; }
[ "$(put "$B" '{"textSize": "130"}' /api/ui)" = 200 ] || { echo "configShared: PUT /api/ui textSize on $B failed"; rc=1; }
[ "$(put "$A" '{"lastPage": "docs"}' /api/ui)" = 200 ] || { echo "configShared: PUT /api/ui lastPage on $A failed"; rc=1; }

ui=$(python3 -c "import json,sys; u=json.load(open(sys.argv[1])).get('ui',{}); print(u.get('lang'), u.get('textSize'), u.get('lastPage'))" "$CFG")
if [ "$ui" != "es 130 docs" ]; then
  echo "configShared: the file's ui is '$ui' - expected 'es 130 docs' (lang through $A, textSize through $B, lastPage through $A)"
  rc=1
fi

[ $rc = 0 ] && echo "configShared: ok"
exit $rc
