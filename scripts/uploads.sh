#!/usr/bin/env bash
# Turn guest uploads for a whole stage off/on (the kill switch), or show the current state.
# Presign refuses within ~30 s (Lambda cache); guests see "Uploads are paused". Events whose window
# has ended are already closed on their own; this is for closing early or pausing an incident.
#
# Usage: scripts/uploads.sh <dev|prod> <off|on|status> [--event <token>]
#   --event  also confirm the change from a guest's point of view (GET /api/event/<token>)
set -euo pipefail

STAGE="${1:-}"
ACTION="${2:-}"
shift 2 || true
EVENT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --event) EVENT="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
[[ "$STAGE" =~ ^(dev|prod)$ && "$ACTION" =~ ^(off|on|status)$ ]] || {
  echo "usage: $0 <dev|prod> <off|on|status> [--event <token>]" >&2
  exit 1
}

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
PARAM="/${PREFIX}/${STAGE}/uploads_enabled"
current() { aws_ ssm get-parameter --name "$PARAM" --query Parameter.Value --output text; }

guest_view() {
  local site
  site="$(aws_ cloudformation describe-stacks --stack-name "${PREFIX}-${STAGE}-app" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)"
  curl -s "$site/api/event/$EVENT" |
    python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("uploadsEnabled")).lower())'
}

if [[ "$ACTION" == "status" ]]; then
  echo "$PARAM = $(current)"
  [[ -n "$EVENT" ]] && echo "guest view: uploadsEnabled=$(guest_view)"
  exit 0
fi

confirm_target_account "$PROFILE"
want=$([[ "$ACTION" == "on" ]] && echo true || echo false)
aws_ ssm put-parameter --name "$PARAM" --value "$want" --overwrite >/dev/null
changed_at=$SECONDS
echo "==> $PARAM = $(current)"

# Each Lambda container caches the switch for up to 30 s, independently, so the change is only
# guaranteed everywhere 30 s after it was made (plus a small margin).
settle() {
  local left=$((35 - (SECONDS - changed_at)))
  if ((left > 0)); then
    echo "==> letting every Lambda cache expire (${left} s)"
    sleep "$left"
  fi
  echo "==> in effect everywhere: uploads $([[ "$want" == true ]] && echo ON || echo OFF) for $STAGE"
}

settle
if [[ -n "$EVENT" ]]; then
  seen="$(guest_view)"
  echo "    guest view: uploadsEnabled=$seen"
  [[ "$seen" == "$want" ]] || { echo "    unexpected; check again shortly" >&2; exit 1; }
fi
