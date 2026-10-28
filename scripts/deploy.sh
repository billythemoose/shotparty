#!/usr/bin/env bash
# Deploy shotparty.  Usage: scripts/deploy.sh <data|app|site|all> <dev|prod>   or   scripts/deploy.sh account
#   data: data stack    app: app stack + site    site: static site only    all: data, app, site
#   account: the <prefix>-account stack (the account-wide budget; one for all stages)
# Every stack deploy shows a CloudFormation change set and waits for confirmation, unless
# SHOTPARTY_ASSUME_YES=1 (npm run setup, CI): then the change set is checked by
# scripts/changeset-guard.ts and executed only if nothing protected would be replaced or deleted.
set -euo pipefail

TARGET="${1:-}"
STAGE="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config

usage() {
  echo "usage: $0 <data|app|site|all> <dev|prod>   or   $0 account" >&2
  exit 1
}
[[ "$TARGET" =~ ^(data|app|site|all|account)$ ]] || usage
[[ "$TARGET" == account || "$STAGE" =~ ^(dev|prod)$ ]] || usage

# sam deploy with the arguments built from shotparty.config.json + the live account (no samconfig.toml).
sam_deploy() {
  local kind="$1"
  load_deploy_params "$kind" "$STAGE"
  # No empty-array expansions: macOS bash 3.2 treats "${empty[@]}" as unbound under set -u.
  local args=(--stack-name "$STACK_NAME" --parameter-overrides "${PARAM_OVERRIDES[@]}"
    --tags "${TAGS[@]}" --region "$REGION" --profile "$PROFILE" --no-fail-on-empty-changeset)
  [[ "$kind" == "app" ]] && args+=(--capabilities CAPABILITY_IAM --resolve-s3)
  if [[ "${SHOTPARTY_ASSUME_YES:-}" != "1" ]]; then
    (cd "$ROOT/infra/$kind" && sam deploy "${args[@]}" --confirm-changeset)
    return
  fi

  # Unattended: create the change set, check it, then execute it ourselves.
  local out changeset new_stack=false
  out="$(cd "$ROOT/infra/$kind" && sam deploy "${args[@]}" --no-execute-changeset 2>&1)" || {
    echo "$out" >&2
    return 1
  }
  echo "$out"
  changeset="$(grep -oE 'arn:aws:cloudformation:[^ ]+:changeSet/[^ ]+' <<<"$out" | head -1 || true)"
  [[ -n "$changeset" ]] || return 0 # "No changes to deploy"
  (cd "$ROOT" && npx --no-install tsx scripts/changeset-guard.ts "$kind" "$changeset") || {
    aws cloudformation delete-change-set --change-set-name "$changeset" \
      --profile "$PROFILE" --region "$REGION" || true
    return 1
  }
  [[ "$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --profile "$PROFILE" \
    --region "$REGION" --query 'Stacks[0].StackStatus' --output text)" == REVIEW_IN_PROGRESS ]] &&
    new_stack=true
  echo "==> Executing change set"
  aws cloudformation execute-change-set --change-set-name "$changeset" \
    --profile "$PROFILE" --region "$REGION"
  if $new_stack; then
    wait_stack create "$STACK_NAME"
  else
    wait_stack update "$STACK_NAME"
  fi
  echo "==> $STACK_NAME is up to date"
}

deploy_data() {
  local stack="${PREFIX}-${STAGE}-data"
  echo "==> Linting data template"
  cfn-lint "$ROOT/infra/data/template.yaml"

  if [[ "${SHOTPARTY_ASSUME_YES:-}" == "1" ]]; then
    echo "==> Deploying $stack (unattended: the change set is checked before it runs)"
  else
    echo "==> Deploying $stack (review the change set; watch for Replacement: True)"
  fi
  sam_deploy data

  echo "==> Enabling termination protection + stack policy on $stack"
  aws cloudformation update-termination-protection --enable-termination-protection \
    --stack-name "$stack" --profile "$PROFILE" --region "$REGION" >/dev/null
  aws cloudformation set-stack-policy --stack-name "$stack" \
    --stack-policy-body "file://$ROOT/infra/data/stack-policy.json" \
    --profile "$PROFILE" --region "$REGION"

  # Names and types only: values include secrets (origin_verify is a plain String).
  echo "==> SSM parameters for $STAGE"
  aws ssm get-parameters-by-path --path "/${PREFIX}/${STAGE}/" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'Parameters[].[Name,Type]' --output table
}

deploy_account() {
  echo "==> Linting account template"
  cfn-lint "$ROOT/infra/account/template.yaml"
  echo "==> Deploying ${PREFIX}-account (the account-wide budget)"
  sam_deploy account
}

deploy_app() {
  local stack="${PREFIX}-${STAGE}-app"
  echo "==> Linting app template"
  cfn-lint "$ROOT/infra/app/template.yaml"

  echo "==> Bundling Lambda handlers"
  npm run build --workspace api --prefix "$ROOT"
  echo "==> Smoke-testing bundles (ESM import, like Lambda)"
  npm run smoke --workspace api --prefix "$ROOT"

  if [[ "${SHOTPARTY_ASSUME_YES:-}" == "1" ]]; then
    echo "==> Deploying $stack (unattended: the change set is checked before it runs)"
  else
    echo "==> Deploying $stack (review the change set)"
    echo "    When the CloudFront distribution changes, sam shows no events for 5-20 min; that's normal."
  fi
  sam_deploy app

  echo "==> Outputs"
  aws cloudformation describe-stacks --stack-name "$stack" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "${PREFIX}-${STAGE}-app" \
    --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

deploy_site() {
  local bucket dist
  bucket="$(stack_output SiteBucketName)"
  dist="$(stack_output DistributionId)"

  echo "==> Building web"
  npm run build --workspace web --prefix "$ROOT"

  echo "==> Syncing web/dist to s3://$bucket"
  # Hashed assets are immutable: a file with the same name has the same content, so comparing
  # sizes is enough. index.html must always be revalidated by browsers.
  local synced changed=false local_md5 remote_etag
  synced="$(aws s3 sync "$ROOT/web/dist" "s3://$bucket" --delete --size-only --exclude index.html \
    --cache-control "public, max-age=31536000, immutable" --profile "$PROFILE" --region "$REGION")"
  [[ -n "$synced" ]] && echo "$synced" && changed=true
  local_md5="$(md5 -q "$ROOT/web/dist/index.html" 2>/dev/null || md5sum "$ROOT/web/dist/index.html" | cut -d' ' -f1)"
  remote_etag="$(aws s3api head-object --bucket "$bucket" --key index.html --profile "$PROFILE" \
    --region "$REGION" --query ETag --output text 2>/dev/null | tr -d '"' || true)"
  if [[ "$local_md5" != "$remote_etag" ]]; then
    aws s3 cp "$ROOT/web/dist/index.html" "s3://$bucket/index.html" \
      --cache-control "no-cache" --profile "$PROFILE" --region "$REGION"
    changed=true
  fi

  if $changed; then
    echo "==> Invalidating CloudFront cache ($dist)"
    aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" \
      --profile "$PROFILE" --query 'Invalidation.Id' --output text
  else
    echo "==> Site unchanged; no invalidation needed"
  fi

  echo "==> Site: $(stack_output SiteUrl)"
}

confirm_target_account "$PROFILE"

# One step per line: bash ignores set -e inside a function called on the left of && or ||, so
# "deploy_app && deploy_site" would carry on (and exit 0) after a failed sam deploy.
case "$TARGET" in
  data) deploy_data ;;
  app)
    deploy_app
    deploy_site
    ;;
  site) deploy_site ;;
  account) deploy_account ;;
  all)
    deploy_data
    deploy_app
    deploy_site
    ;;
esac
