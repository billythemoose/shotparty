#!/usr/bin/env bash
# Render every D2 diagram in docs/diagrams/ to a light and a dark SVG, for <picture> tags that
# follow the reader's color scheme. Needs d2 (brew install d2) and network access: the AWS icons
# are fetched from icons.terrastruct.com and embedded in the SVGs.
#
# Usage: scripts/render-diagrams.sh      (or npm run diagrams)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v d2 >/dev/null || {
  echo "d2 is not installed: brew install d2 (or see https://d2lang.com)" >&2
  exit 1
}

for src in "$ROOT"/docs/diagrams/*.d2; do
  base="${src%.d2}"
  # Theme 0 is "Neutral default", 200 is "Dark Mauve".
  d2 --layout elk --theme 0 --pad 24 "$src" "$base-light.svg"
  d2 --layout elk --theme 200 --pad 24 "$src" "$base-dark.svg"
done
