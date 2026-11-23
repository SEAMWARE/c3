#!/usr/bin/env bash
#
# populateBroker.sh - AI Assist's populate_broker end to end (test/populateBroker.mjs): a c3 and two coraine brokers
# on corDB in memory - one keeping temporal history (--troe corDB), one not (--troe none) - started here, stopped
# at the end. Skipped when coraine or node is not installed.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/populateBroker.sh [<c3 binary>]   default ./c3; ports 7921 (c3), 1046 and 1047 (the brokers) -
#                                         C3_TEST_PORT_POP, C3_TEST_BROKER_HIST, C3_TEST_BROKER_PLAIN
#
set -u
C3=${1:-./c3}
cd "$(dirname "$0")/.." || exit 1
command -v node    > /dev/null || { echo "populateBroker: node not found - skipped"; exit 0; }
command -v coraine > /dev/null || { echo "populateBroker: coraine not installed - skipped"; exit 0; }

P=${C3_TEST_PORT_POP:-7921}
H=${C3_TEST_BROKER_HIST:-1046}
N=${C3_TEST_BROKER_PLAIN:-1047}
DIR=$(mktemp -d)
pids=()

finish() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

up() {   # <name> <url> - wait until it answers
  for _ in $(seq 1 100); do curl -s -o /dev/null "$2" && return 0; sleep 0.1; done
  echo "populateBroker: $1 did not start - $DIR/$1.log"; cat "$DIR/$1.log"; exit 1
}

coraine -p "$H" -db corDB -troe corDB -troeSync -corPort 0 > "$DIR/hist.log" 2>&1 &
pids+=($!)
coraine -p "$N" -db corDB -troe none -corPort 0 > "$DIR/plain.log" 2>&1 &
pids+=($!)
"$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pids+=($!)

up hist  "http://127.0.0.1:$H/version"
up plain "http://127.0.0.1:$N/version"
up c3    "http://127.0.0.1:$P/"

node test/populateBroker.mjs "http://127.0.0.1:$P" "http://127.0.0.1:$H" "http://127.0.0.1:$N"
