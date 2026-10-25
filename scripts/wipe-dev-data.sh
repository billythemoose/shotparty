#!/usr/bin/env bash
# Reset DEV to an empty state: deletes every object version in the dev media bucket and every item
# in the dev table (events, sessions, counters, rejection records). Stacks, secrets, Turnstile and
# the CloudFront plan are untouched. Refuses to run against prod.
#
# Usage: scripts/wipe-dev-data.sh      (asks you to type "wipe dev")
set -euo pipefail

STAGE=dev
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

confirm_target_account "$PROFILE"
BUCKET="$(aws_ ssm get-parameter --name "/${PREFIX}/${STAGE}/mediaBucketName" --query Parameter.Value --output text)"
TABLE="$(aws_ ssm get-parameter --name "/${PREFIX}/${STAGE}/tableName" --query Parameter.Value --output text)"
# Belt and braces: the names come from /<prefix>/dev/*, but never touch anything prod-named.
[[ "$BUCKET" == "$PREFIX"-dev-* && "$TABLE" == "$PREFIX"-dev-* ]] || { echo "refusing: not dev resources ($BUCKET, $TABLE)" >&2; exit 1; }

echo "This permanently deletes ALL media in s3://$BUCKET and ALL items in $TABLE."
read -r -p "Type 'wipe dev' to continue: " answer
[[ "$answer" == "wipe dev" ]] || { echo "Aborted." >&2; exit 1; }

echo "==> Deleting every object version and delete marker in $BUCKET"
removed=0
for kind in Versions DeleteMarkers; do
  while true; do
    batch="$(aws_ s3api list-object-versions --bucket "$BUCKET" --max-items 1000 \
      --query "{Objects: ${kind}[].{Key:Key,VersionId:VersionId}}" --output json)"
    [[ "$batch" == *'"Key"'* ]] || break
    n="$(printf '%s' "$batch" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["Objects"]))')"
    aws_ s3api delete-objects --bucket "$BUCKET" --delete "$batch" >/dev/null
    removed=$((removed + n))
  done
done
echo "    removed $removed"

echo "==> Deleting every item in $TABLE"
items=0
while true; do
  keys="$(aws_ dynamodb scan --table-name "$TABLE" --projection-expression "pk, sk" --max-items 25 \
    --query 'Items' --output json)"
  [[ "$keys" == "[]" || "$keys" == "null" ]] && break
  request="$(TABLE="$TABLE" python3 -c '
import json, os, sys
keys = json.load(sys.stdin)
print(json.dumps({os.environ["TABLE"]: [{"DeleteRequest": {"Key": k}} for k in keys]}))' <<<"$keys")"
  aws_ dynamodb batch-write-item --request-items "$request" >/dev/null
  items=$((items + $(python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' <<<"$keys")))
done
echo "    removed $items"
echo "==> dev is empty. Create a fresh test event with: npm run event:create -- --stage dev --name ..."
