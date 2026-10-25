#!/usr/bin/env bash
# OPTIONAL: copy a downloaded event (npm run download) to Google Drive, or any rclone remote.
# Uses the verified local copy rather than S3, so Drive gets exactly what was checked.
#
# One-time setup:  brew install rclone && rclone config   (create a "Google Drive" remote, e.g. gdrive)
# Usage: scripts/sync-to-drive.sh <dev|prod> <event-folder> <remote:path> [--dry-run]
#   e.g. scripts/sync-to-drive.sh prod pizza-and-games-2026 gdrive:Events/Guest-Photos
set -euo pipefail

STAGE="${1:-}"
EVENT="${2:-}"
DEST="${3:-}"
DRY="${4:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/photos/$STAGE/$EVENT"

[[ "$STAGE" =~ ^(dev|prod)$ && -n "$EVENT" && "$DEST" == *:* ]] || {
  echo "usage: $0 <dev|prod> <event-folder> <remote:path> [--dry-run]" >&2
  exit 1
}
command -v rclone >/dev/null || { echo "rclone not installed: brew install rclone && rclone config" >&2; exit 1; }
remote="${DEST%%:*}"
rclone listremotes | grep -qx "${remote}:" || { echo "rclone remote '$remote' not configured: run rclone config" >&2; exit 1; }
[[ -f "$SRC/manifest.csv" ]] || { echo "no verified download at $SRC: run npm run download -- --stage $STAGE --event $EVENT" >&2; exit 1; }

args=(copy "$SRC" "$DEST" --progress --checksum)
[[ "$DRY" == "--dry-run" ]] && args+=(--dry-run)
echo "==> rclone ${args[*]}"
rclone "${args[@]}"
echo "==> checking $DEST against the local copy"
rclone check "$SRC" "$DEST" --one-way
