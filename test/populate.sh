#!/usr/bin/env bash
#
# populate.sh - AI Assist's populate_broker generator (www/js/populate.js), run under node: test/populate.mjs
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/populate.sh [<c3 binary>]     the binary is not needed - make test passes it to every test
#
cd "$(dirname "$0")/.." || exit 1
command -v node > /dev/null || { echo "populate: node not found - skipped"; exit 0; }
exec node test/populate.mjs
