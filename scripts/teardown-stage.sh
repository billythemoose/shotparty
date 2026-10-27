#!/usr/bin/env bash
# PERMANENTLY destroy one stage (app stack, data stack, AND the retained media bucket + table,
# including every uploaded photo) in the target account. Intended for throwaway test deployments,
# e.g. a trial run in another account. Never run this against a stage whose photos you need.
#
# Usage: SHOTPARTY_PROFILE=<profile> scripts/teardown-stage.sh <dev|prod>
set -euo pipefail

STAGE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "usage: $0 <dev|prod>" >&2; exit 1; }

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

confirm_target_account "$PROFILE"
echo "This deletes EVERYTHING for stage '$STAGE' in that account, including all uploaded media."
read -r -p "Type 'destroy $STAGE' to continue: " answer
[[ "$answer" == "destroy $STAGE" ]] || { echo "Aborted." >&2; exit 1; }

DATA_STACK="${PREFIX}-${STAGE}-data"
APP_STACK="${PREFIX}-${STAGE}-app"

stack_exists() { aws_ cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }
data_output() {
  aws_ cloudformation describe-stacks --stack-name "$DATA_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

# 1. App stack (site bucket emptied first; a flat-rate plan must be canceled first, and its web ACL
#    is deleted after the distribution).
if stack_exists "$APP_STACK"; then
  DIST="$(aws_ cloudformation describe-stacks --stack-name "$APP_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)"
  PLAN_ACL="$(plan_web_acl "$PROFILE" "$DIST")"
  confirm_no_pricing_plan "$PROFILE" "$DIST"
  SITE_BUCKET="$(aws_ cloudformation describe-stacks --stack-name "$APP_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)"
  if [[ -n "$SITE_BUCKET" && "$SITE_BUCKET" != "None" ]]; then
    echo "==> Emptying site bucket $SITE_BUCKET"
    aws_ s3 rm "s3://$SITE_BUCKET" --recursive
  fi
  echo "==> Deleting $APP_STACK"
  aws_ cloudformation delete-stack --stack-name "$APP_STACK"
  aws_ cloudformation wait stack-delete-complete --stack-name "$APP_STACK"
  delete_plan_web_acl "$PROFILE" "$PLAN_ACL"
fi

# 2. Data stack. Bucket and table are Retain, so they survive the stack and are removed below.
MEDIA_BUCKET=""
TABLE=""
if stack_exists "$DATA_STACK"; then
  MEDIA_BUCKET="$(data_output MediaBucketName)"
  TABLE="$(data_output DataTableName)"
  echo "==> Disabling termination protection and deleting $DATA_STACK"
  aws_ cloudformation update-termination-protection --no-enable-termination-protection \
    --stack-name "$DATA_STACK" >/dev/null
  aws_ cloudformation delete-stack --stack-name "$DATA_STACK"
  aws_ cloudformation wait stack-delete-complete --stack-name "$DATA_STACK"
else
  echo "Data stack not found; set MEDIA_BUCKET_OVERRIDE / TABLE_OVERRIDE to remove leftovers."
  MEDIA_BUCKET="${MEDIA_BUCKET_OVERRIDE:-}"
  TABLE="${TABLE_OVERRIDE:-}"
fi

# 3. Media bucket: versioned, so every object version and delete marker must go.
if [[ -n "$MEDIA_BUCKET" ]] && aws_ s3api head-bucket --bucket "$MEDIA_BUCKET" >/dev/null 2>&1; then
  echo "==> Emptying versioned media bucket $MEDIA_BUCKET"
  for kind in Versions DeleteMarkers; do
    while true; do
      batch="$(aws_ s3api list-object-versions --bucket "$MEDIA_BUCKET" --max-items 1000 \
        --query "{Objects: ${kind}[].{Key:Key,VersionId:VersionId}}" --output json)"
      [[ "$batch" == *'"Key"'* ]] || break
      aws_ s3api delete-objects --bucket "$MEDIA_BUCKET" --delete "$batch" >/dev/null
    done
  done
  echo "==> Deleting bucket $MEDIA_BUCKET"
  aws_ s3api delete-bucket --bucket "$MEDIA_BUCKET"
fi

# 4. Table: deletion protection must be switched off first.
if [[ -n "$TABLE" ]] && aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  echo "==> Deleting table $TABLE"
  aws_ dynamodb update-table --table-name "$TABLE" --no-deletion-protection-enabled >/dev/null
  aws_ dynamodb wait table-exists --table-name "$TABLE"
  aws_ dynamodb delete-table --table-name "$TABLE" >/dev/null
fi

# 5. Secrets from bootstrap-secrets.sh, which no stack owns. alert_email is shared by both stages,
#    so it goes only once the other stage has no stacks left.
for name in $(aws_ ssm get-parameters-by-path --path "/$PREFIX/$STAGE" --recursive \
  --query 'Parameters[].Name' --output text); do
  echo "==> Deleting parameter $name"
  aws_ ssm delete-parameter --name "$name"
done
OTHER_STAGE="$([[ "$STAGE" == "prod" ]] && echo dev || echo prod)"
if ! stack_exists "${PREFIX}-${OTHER_STAGE}-app" && ! stack_exists "${PREFIX}-${OTHER_STAGE}-data" \
  && aws_ ssm get-parameter --name "/$PREFIX/alert_email" >/dev/null 2>&1; then
  echo "==> Deleting parameter /$PREFIX/alert_email (no other stage left)"
  aws_ ssm delete-parameter --name "/$PREFIX/alert_email"
fi

echo "==> Stage '$STAGE' removed from this account."
echo "    Also left behind (shared by all SAM deploys in this account/region, pennies):"
echo "    the 'aws-sam-cli-managed-default' stack and its artifact bucket. Remove via the"
echo "    CloudFormation console after emptying that bucket, if this account is done with SAM."
