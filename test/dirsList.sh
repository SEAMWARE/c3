#!/usr/bin/env bash
#
# dirsList.sh - the folder picker of Compile's directory of clones: GET /api/compile/dirs?path= lists a directory's
# subdirectories (hidden ones and files left out, sorted), marks the git clones, says whether coraine is one; no path
# is $HOME, a leading ~ is $HOME; a relative or missing path is 404.
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
#   test/dirsList.sh [<c3 binary>]     default ./c3; port 7917 (C3_TEST_PORT_G)
#
# Exit 0 and "dirsList: ok", or 1 and what failed.
#
set -u
C3=${1:-./c3}
P=${C3_TEST_PORT_G:-7917}
DIR=$(mktemp -d)
pid=

finish() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; wait 2>/dev/null; rm -rf "$DIR"; }
trap finish EXIT

T="$DIR/home/src"
mkdir -p "$T/zeta" "$T/coraine/.git" "$T/alpha/.git" "$T/.hidden" "$DIR/home/sub"
touch "$T/afile"
HOME="$DIR/home" "$C3" --port "$P" --no-browser --config "$DIR/c3.json" > "$DIR/c3.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$P/" && break; sleep 0.1; done

rc=0
# expect <query> <status> <python check on the answer d, or ''> <what>
expect() {
  local got; got=$(curl -s -o "$DIR/body" -w '%{http_code}' "http://127.0.0.1:$P/api/compile/dirs$1")
  if [ "$got" != "$2" ]; then echo "dirsList: $4: HTTP $got, not $2: $(head -c 300 "$DIR/body")"; rc=1; return; fi
  [ -z "$3" ] && return
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if ($3) else 1)" "$DIR/body" \
    || { echo "dirsList: $4: $(head -c 400 "$DIR/body")"; rc=1; }
}

R=$(cd "$DIR" && pwd -P)
expect "?path=$T"      200 "[x['name'] for x in d['dirs']] == ['alpha','coraine','zeta']"            'subdirectories, sorted, no hidden, no files'
expect "?path=$T"      200 "[x['git'] for x in d['dirs']] == [True,True,False] and d['coraine'] is True" 'git clones marked, coraine found'
expect "?path=$T"      200 "d['path'] == '$R/home/src' and d['parent'] == '$R/home'"                 'path and parent'
expect ""              200 "d['path'] == '$R/home' and d['coraine'] is False"                        'no path: $HOME'
expect "?path=%7E/src" 200 "d['path'] == '$R/home/src'"                                              'a leading ~ is $HOME'
expect "?path=/"       200 "d['parent'] is None"                                                     '/ has no parent'
expect "?path=src"     404 ''                                                                        'a relative path'
expect "?path=$T/nope" 404 ''                                                                        'a missing directory'

[ $rc = 0 ] && echo "dirsList: ok" || cat "$DIR/c3.log"
exit $rc
