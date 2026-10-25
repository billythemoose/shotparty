#!/usr/bin/env bash
# Removes a stage. Usage: npm run teardown -- <dev|prod> [--keep-data]
#   --keep-data   delete only the app stack (site, API, alarms); photos and events stay
#                 (scripts/delete-app.sh). Run npm run setup to bring the app back.
#   (default)     delete everything for the stage, photos included (scripts/teardown-stage.sh,
#                 which asks you to type "destroy <stage>").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${1:-}"
[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "usage: npm run teardown -- <dev|prod> [--keep-data]" >&2; exit 1; }
if [[ "${2:-}" == "--keep-data" ]]; then
  exec "$ROOT/scripts/delete-app.sh" "$STAGE"
fi
exec "$ROOT/scripts/teardown-stage.sh" "$STAGE"
