#!/bin/bash
#
# docsPublish.sh - the documentation website into a clone of SEAMWARE/docs (seamware.github.io/docs)
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: tools/docsPublish.sh <clone of SEAMWARE/docs> [<release tag>]
#
#   latest/       the site built from this checkout (make site VERSION=latest) - main, when published
#   <version>/    with a tag (v0.6.0): the site as that tag has it, in 0.6.0/; the root then sends to it
#   index.html    the root: to the newest release there is, else to latest/
#
# GitHub Pages serves the clone's main branch as it is. This writes the directories and commits; the push is
# left to the caller (git -C <clone> push), after a look at what changed.
#
set -euo pipefail

docs="${1:?usage: tools/docsPublish.sh <clone of SEAMWARE/docs> [<release tag>]}"
tag="${2:-}"
c3="$(cd "$(dirname "$0")/.." && pwd)"

# The clone's top - a clone or a worktree of one (whose .git is a file), not a directory inside some other repository
[ "$(git -C "$docs" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$docs" && pwd -P)" ] \
  || { echo "docsPublish.sh: $docs is not a git clone"; exit 1; }

make -C "$c3" -s site SITE="$docs/latest" VERSION=latest

if [ -n "$tag" ]; then
  version="${tag#v}"
  tmp="$(mktemp -d)"
  trap 'git -C "$c3" worktree remove --force "$tmp/c3" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
  git -C "$c3" worktree add --detach "$tmp/c3" "$tag" >/dev/null
  make -C "$tmp/c3" -s site SITE="$docs/$version" VERSION="$version"
fi

#
# The root: the newest release directory (a version number), else latest/
#
newest="$(cd "$docs" && ls -d [0-9]*.[0-9]*.[0-9]* 2>/dev/null | sort -V | tail -1 || true)"
target="${newest:-latest}"
cat > "$docs/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<title>coraine documentation</title>
<meta http-equiv="refresh" content="0; url=$target/">
<link rel="canonical" href="$target/">
<a href="$target/">coraine documentation</a>
HTML
touch "$docs/.nojekyll"

git -C "$docs" add -A
if git -C "$docs" diff --cached --quiet; then
  echo "docsPublish.sh: nothing changed"
else
  git -C "$docs" commit -q -m "The documentation from c3 $(git -C "$c3" rev-parse --short HEAD)${tag:+, and $tag}"
  echo "docsPublish.sh: committed in $docs - git -C $docs push, to publish"
fi
