#!/bin/sh
#
# stopReplaced.sh <path> - stop every c3 still running from <path> after an install replaced the file
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# make install calls it (not with DESTDIR: a package is built there, nothing of it runs). A c3 started from
# the file an install has just replaced runs the earlier build: /proc/<pid>/exe reads "<path> (deleted)".
# Started again (the dock's button) it would only be opened again - a c3 of 0.6.1 or later replaces such a
# one itself, an earlier one does not say its pid (GET /api/status) and is not recognised. Stopped here with
# SIGTERM, as a stop by hand - its brokers' subscriptions deleted, a build it runs cancelled - the next start
# is the new build. Waits up to 10 s for each. Linux only (/proc); elsewhere nothing is done.
#
path=$1
[ -n "$path" ] || { echo "usage: stopReplaced.sh <path of the installed c3>" >&2; exit 1; }
[ -d /proc/self ] || exit 0

for exe in /proc/[0-9]*/exe; do
  [ "$(readlink "$exe" 2>/dev/null)" = "$path (deleted)" ] || continue
  pid=${exe#/proc/}
  pid=${pid%/exe}
  echo "c3 (pid $pid) runs the build $path replaced - stopping it; the next start is the new one"
  kill -TERM "$pid" 2>/dev/null || continue
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt 20 ]; do
    sleep 0.5
    n=$((n + 1))
  done
  kill -0 "$pid" 2>/dev/null && echo "c3 (pid $pid) is still running - stop it by hand" >&2
done
exit 0
