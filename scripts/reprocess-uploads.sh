#!/usr/bin/env bash
# Re-run the validate Lambda on every object still waiting under uploads/ (e.g. uploaded while the
# validator was down, or after EventBridge gave up retrying). Real media moves to accepted/, the
# rest is deleted, exactly as for a live upload. Safe to re-run: already-moved objects are skipped.
#
# Usage: scripts/reprocess-uploads.sh <dev|prod> [--dry-run] [--prefix uploads/<event>/]
set -euo pipefail

STAGE="${1:-}"
shift || true
DRY_RUN=false
PREFIX="uploads/"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --prefix) PREFIX="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "usage: $0 <dev|prod> [--dry-run] [--prefix uploads/...]" >&2; exit 1; }
[[ "$PREFIX" == uploads/* ]] || { echo "--prefix must start with uploads/" >&2; exit 1; }

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

confirm_target_account "$PROFILE"

BUCKET="$(aws_ ssm get-parameter --name "/${PREFIX}/${STAGE}/mediaBucketName" --query Parameter.Value --output text)"
FUNCTION="$(aws_ cloudformation describe-stack-resource --stack-name "${PREFIX}-${STAGE}-app" \
  --logical-resource-id ValidateFunction --query StackResourceDetail.PhysicalResourceId --output text)"

# Latest version of each waiting object: key, version id, size (tab-separated).
LIST="$(aws_ s3api list-object-versions --bucket "$BUCKET" --prefix "$PREFIX" \
  --query 'Versions[?IsLatest].[Key,VersionId,Size]' --output text)"
if [[ -z "$LIST" || "$LIST" == "None" ]]; then
  echo "Nothing waiting under s3://$BUCKET/$PREFIX"
  exit 0
fi

COUNT="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
echo "==> $COUNT object(s) waiting under s3://$BUCKET/$PREFIX (validator: $FUNCTION)"
if $DRY_RUN; then
  printf '%s\n' "$LIST" | awk -F'\t' '{printf "    %s (%s bytes)\n", $1, $3}'
  exit 0
fi
read -r -p "Reprocess all $COUNT? [y/N] " answer
[[ "$answer" == "y" ]] || { echo "Aborted." >&2; exit 1; }

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
declare -i accepted=0 rejected=0 skipped=0 failed=0

while IFS=$'\t' read -r key version size; do
  # Same shape as the EventBridge "Object Created" event (key URL-encoded, like S3 sends it).
  payload="$(KEY="$key" VERSION="$version" SIZE="$size" BUCKET="$BUCKET" python3 -c '
import json, os, urllib.parse
obj = {"key": urllib.parse.quote_plus(os.environ["KEY"], safe="/"), "size": int(os.environ["SIZE"])}
if os.environ["VERSION"] not in ("", "null", "None"):
    obj["version-id"] = os.environ["VERSION"]
print(json.dumps({"detail": {"bucket": {"name": os.environ["BUCKET"]}, "object": obj}}))')"

  if ! aws_ lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out \
    --payload "$payload" "$OUT" --query FunctionError --output text >"$OUT.err" 2>&1 \
    || [[ "$(cat "$OUT.err")" != "None" ]]; then
    failed+=1
    echo "    FAIL     $key: $(cat "$OUT")"
    continue
  fi
  result="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"])' "$OUT")"
  case "$result" in
    accepted) accepted+=1 ;;
    rejected) rejected+=1 ;;
    *) skipped+=1 ;;
  esac
  printf '    %-8s %s\n' "$result" "$key"
done <<<"$LIST"
rm -f "$OUT.err"

echo "==> accepted=$accepted rejected=$rejected skipped=$skipped failed=$failed"
[[ $failed -eq 0 ]]
