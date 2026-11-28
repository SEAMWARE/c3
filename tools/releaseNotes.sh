#!/bin/bash
#
# releaseNotes.sh - the notes of a c³ release (its GitHub Release page), from git: the pull requests merged since
# the previous tag, by kind
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: tools/releaseNotes.sh <tag>          (v0.8.0) - markdown on stdout; nothing is changed
#
# Each pull request is its merge commit: "Merge pull request #N from SEAMWARE/<branch>", its title the body's first
# line. Its kind is the branch's first component: feat -> New, fix -> Fixed, docs -> Documentation, the rest ->
# Other; the version bump (chore/version-*) is left out. The first tag, with no previous one: its commits counted.
# .github/workflows/release.yml runs it when a tag is pushed.
#
set -eu

tag=${1:?usage: releaseNotes.sh <tag>}
version=${tag#v}
git rev-parse -q --verify "refs/tags/$tag" > /dev/null || { echo "releaseNotes.sh: no tag $tag" >&2; exit 1; }

prev=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$tag^" 2>/dev/null || true)

echo "c³ $version goes with [coraine $version](https://github.com/SEAMWARE/coraine/releases/tag/$tag)."
echo
if git show "$tag:Formula/c3.rb" 2> /dev/null | grep -q '^  stable do'
then
  echo "**Install:** on a Mac, \`brew tap seamware/c3 https://github.com/SEAMWARE/c3 && brew install seamware/c3/c3\`;"
  echo "on Linux from the sources at this tag; a broker in Docker - [INSTALL.md](https://github.com/SEAMWARE/c3/blob/$tag/INSTALL.md)."
else
  echo "**Install:** from the sources at this tag - [README.md](https://github.com/SEAMWARE/c3/blob/$tag/README.md)."
fi
echo

if [ -z "$prev" ]
then
  echo "The first release: $(git rev-list --count "$tag") commits."
  exit 0
fi

declare -A section=([feat]="" [fix]="" [docs]="" [other]="")
while IFS=$'\t' read -r sha subject
do
  [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+)\ from\ [^/]+/(.+)$ ]] || continue
  pr=${BASH_REMATCH[1]}
  branch=${BASH_REMATCH[2]}
  [[ "$branch" == chore/version-* ]] && continue
  title=$(git log -1 --format=%b "$sha" | sed -n '/./{p;q}')
  [ -n "$title" ] || title=$branch
  kind=${branch%%/*}
  [[ -v "section[$kind]" ]] || kind=other
  section[$kind]+="- $title (#$pr)"$'\n'
done < <(git log --merges --reverse --format=$'%H\t%s' "$prev..$tag")

for kind in feat fix docs other
do
  [ -n "${section[$kind]}" ] || continue
  case $kind in
    feat)  echo "### New" ;;
    fix)   echo "### Fixed" ;;
    docs)  echo "### Documentation" ;;
    other) echo "### Other" ;;
  esac
  echo
  printf '%s' "${section[$kind]}"
  echo
done

echo "**All changes:** [$prev...$tag](https://github.com/SEAMWARE/c3/compare/$prev...$tag)"
