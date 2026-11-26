#!/usr/bin/env bash
#
# proxySmoke.sh - c3 serves its page, and its proxy takes a request to a broker and brings the answer back:
# the HTTP server, the suspended request resumed from the client's thread, the client - on every system c3
# builds for (on macOS: corBase/corLinux.h's kqueue and pipe stand-ins). The broker is a stub: python3's
# http.server on a directory holding /ngsi-ld/v1/types.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/proxySmoke.sh [<c3 binary>]     default ./c3; ports 7913 (c3) and 7914 (the stub), C3_TEST_PORT_C / _D
#
# Exit 0 and "proxySmoke: ok", or 1 and what failed.
#
set -u
C3=${1:-./c3}
P=${C3_TEST_PORT_C:-7913}
S=${C3_TEST_PORT_D:-7914}
DIR=$(mktemp -d)
pids=()

finish() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

mkdir -p "$DIR/stub/ngsi-ld/v1"
printf '["urn:ngsi-ld:Type:Machine", "urn:ngsi-ld:Type:Hall"]' > "$DIR/stub/ngsi-ld/v1/types"
python3 -m http.server "$S" --bind 127.0.0.1 --directory "$DIR/stub" > "$DIR/stub.log" 2>&1 &
pids+=($!)

"$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pids+=($!)

up=no
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://127.0.0.1:$P/" && curl -s -o /dev/null "http://127.0.0.1:$S/ngsi-ld/v1/types"; then up=yes; break; fi
  sleep 0.1
done
[ $up = yes ] || { echo "proxySmoke: c3 on $P or the stub on $S did not start"; cat "$DIR/c3.log" "$DIR/stub.log"; exit 1; }

rc=0
page=$(curl -s "http://127.0.0.1:$P/")
case "$page" in *"<html"*) ;; *) echo "proxySmoke: GET / is not the page: ${page:0:200}"; rc=1 ;; esac

for i in 1 2 3; do                                     # three: the suspend/resume path again after its first use
  body=$(curl -s -w ' %{http_code}' -H "X-C3-Broker: http://127.0.0.1:$S" "http://127.0.0.1:$P/api/proxy/ngsi-ld/v1/types")
  case "$body" in *Machine*" 200") ;; *) echo "proxySmoke: proxied GET $i: '$body'"; rc=1 ;; esac
done

#
# The writes the proxy forwards - the stub answers them 501 (http.server has no POST, PATCH, DELETE): forwarded,
# not the proxy's own 403 - and the ones it refuses (403). Origin: this machine, as c3's page sends it
#
write() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "X-C3-Broker: http://127.0.0.1:$S" -H "Origin: http://127.0.0.1:$P" \
          -H 'Content-Type: application/json' --data '{}' "http://127.0.0.1:$P/api/proxy$2"; }
T=/ngsi-ld/v1/temporal/entities
for w in "POST $T" "POST $T/urn:x/attrs" "PATCH $T/urn:x/attrs/a/urn:i" "DELETE $T/urn:x/attrs/a/urn:i" "DELETE $T/urn:x/attrs/a" \
         "DELETE $T/urn:x" "POST /ngsi-ld/v1/temporal/entityOperations/query"; do
  code=$(write $w)
  [ "$code" = 403 ] && { echo "proxySmoke: $w refused by the proxy - it is forwarded"; rc=1; }
done
for w in "PUT $T/urn:x" "POST /ngsi-ld/v1/temporal/entityOperations/delete" "DELETE /ngsi-ld/v1/csourceRegistrations/urn:r"; do
  code=$(write $w)
  [ "$code" = 403 ] || { echo "proxySmoke: $w answered $code - the proxy refuses it (403)"; rc=1; }
done

[ $rc = 0 ] && echo "proxySmoke: ok" || cat "$DIR/c3.log"
exit $rc
