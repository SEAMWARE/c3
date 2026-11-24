#!/usr/bin/env bash
#
# imageFile.sh - Compile's "Save as a file": POST /api/builds/command (nothing run) passes --image-file after --image;
# imageFile without an image is 422; the choice keeps output and imageFile (PUT /api/compile/choice, read back from
# /api/config) and refuses an imageFile that is not true or false.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/imageFile.sh [<c3 binary>]     default ./c3; port 7918 (C3_TEST_PORT_H)
#
# Exit 0 and "imageFile: ok", or 1 and what failed.
#
set -u
C3=${1:-./c3}
P=${C3_TEST_PORT_H:-7918}
DIR=$(mktemp -d)
pid=

finish() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

"$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$P/" && break; sleep 0.1; done

rc=0
# expect <method> <path> <body> <status> <check> <what>
#   200: <check> a python expression on the answer d, or ''; 4xx: <check> text the refusal's detail holds
expect() {
  local got; got=$(curl -s -o "$DIR/body" -w '%{http_code}' -X "$1" -H 'Content-Type: application/json' ${3:+-d "$3"} "http://127.0.0.1:$P$2")
  if [ "$got" != "$4" ]; then echo "imageFile: $6: HTTP $got, not $4: $(head -c 300 "$DIR/body")"; rc=1; return; fi
  [ -z "$5" ] && return
  if [ "$got" = 200 ]; then
    python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if ($5) else 1)" "$DIR/body" \
      || { echo "imageFile: $6: $(head -c 400 "$DIR/body")"; rc=1; }
  elif ! grep -q -F -- "$5" "$DIR/body"; then
    echo "imageFile: $6: HTTP $got, but not for '$5': $(head -c 300 "$DIR/body")"; rc=1
  fi
}

C=/api/builds/command
expect POST $C '{"mode":"release","image":true,"imageFile":true}' 200 \
  "d['argv'][d['argv'].index('--image')+2] == '--image-file' and d['imageFile'] is True"   '--image-file after --image <name>'
expect POST $C '{"mode":"release","image":"quay.io/x/coraine:t","imageFile":false}' 200 \
  "'--image-file' not in d['argv'] and d['imageFile'] is False"                          'imageFile false: no --image-file'
expect POST $C '{"mode":"release","imageFile":true}' 422 'the image is saved under its name'       'imageFile without an image'

expect PUT /api/compile/choice '{"mode":"release","features":{},"bridges":{},"workload":"","httpServer":"mhd","output":"image","imageFile":true}' 200 '' 'the choice with output and imageFile'
expect GET /api/config '' 200 "d['compile']['choice']['output'] == 'image' and d['compile']['choice']['imageFile'] is True" 'output and imageFile kept'
expect PUT /api/compile/choice '{"mode":"release","imageFile":"yes"}' 400 'is true or false (the image saved as a file too)'  'imageFile not a boolean'

[ $rc = 0 ] && echo "imageFile: ok" || cat "$DIR/c3.log"
exit $rc
