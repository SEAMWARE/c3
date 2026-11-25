#!/usr/bin/env bash
# wirecloud-theme.sh [wirecloud checkout] - compile c³'s WireCloud theme (www/wirecloud/c3theme) with WireCloud's own build
#
# The theme's sources are static/css/_variables.scss and static/css/c3.scss; the result, static/css/c3theme_*.css, is
# committed (c³ mounts the folder into WireCloud's container - no WireCloud build on the user's machine). The
# checkout (default ~/git/wirecloud) needs its npm packages (npm ci); the theme is copied into it for the build
# and removed after.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
wc=${1:-$HOME/git/wirecloud}
theme=$here/www/wirecloud/c3theme
[ -d "$wc/node_modules" ] || { echo "$wc: no node_modules - run npm ci there first" >&2; exit 1; }
dst=$wc/src/wirecloud/themes/c3theme
trap '\rm -rf "$dst"' EXIT
\rm -rf "$dst"
mkdir -p "$dst"
\cp -r "$theme/__init__.py" "$theme/theme.ts" "$dst/"
mkdir -p "$dst/static/css"
\cp "$theme"/static/css/*.scss "$dst/static/css/"
(cd "$wc" && npm run build:css > "$here/build/wirecloud-theme.log" 2>&1) || { echo "the build failed - build/wirecloud-theme.log" >&2; exit 1; }
\rm -f "$theme"/static/css/c3theme_*.css
\cp "$wc"/src/wirecloud/dist/css/c3theme_*.css "$theme/static/css/" 2>/dev/null || \cp "$wc"/dist/css/c3theme_*.css "$theme/static/css/"
ls -la "$theme"/static/css/c3theme_*.css
