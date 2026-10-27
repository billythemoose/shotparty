#!/usr/bin/env bash
# Delete the APP stack for a stage (the data stack and its photos are untouched).
# ⚠️ prod: after QR cards are printed, don't run this until the upload window has closed; the
# recreated CloudFront distribution gets a new URL and every printed code would break.
# CloudFormation can't delete a non-empty bucket, so the site bucket is emptied first;
# its contents are rebuilt by the next `scripts/deploy.sh app <stage>`.
# Usage: scripts/delete-app.sh <dev|prod>
set -euo pipefail

STAGE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "usage: $0 <dev|prod>" >&2; exit 1; }

confirm_target_account "$PROFILE"

STACK="${PREFIX}-${STAGE}-app"
BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text 2>/dev/null || true)"

DIST="$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null || true)"
PLAN_ACL="$(plan_web_acl "$PROFILE" "$DIST")"
confirm_no_pricing_plan "$PROFILE" "$DIST"

if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  echo "==> Emptying site bucket s3://$BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --profile "$PROFILE" --region "$REGION"
fi

echo "==> Deleting $STACK (sam will ask for confirmation)"
sam delete --stack-name "$STACK" --region "$REGION" --profile "$PROFILE"

# The plan's web ACL can only go once the distribution has (sam delete may have been declined).
if ! aws cloudformation describe-stacks --stack-name "$STACK" \
  --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  delete_plan_web_acl "$PROFILE" "$PLAN_ACL"
fi
