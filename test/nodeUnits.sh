#!/usr/bin/env bash
#
# nodeUnits.sh - the page's pure parts, run under node: the History panel's (test/temporal.mjs) and AI Assist's
# show_history (test/showHistory.mjs) and focus (test/focus.mjs); Operate's Metrics (test/metrics.mjs)
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/nodeUnits.sh [<c3 binary>]    the binary is not needed - make test passes it to every test
#
cd "$(dirname "$0")/.." || exit 1
command -v node > /dev/null || { echo "nodeUnits: node not found - skipped"; exit 0; }
node test/temporal.mjs && node test/showHistory.mjs && node test/focus.mjs && node test/metrics.mjs
