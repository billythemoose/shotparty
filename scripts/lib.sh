# shellcheck shell=bash
# Shared helpers for shotparty scripts (sourced, not executed). Expects $ROOT (the repo root).

# Reads shotparty.config.json (or $SHOTPARTY_CONFIG) and sets CONFIG_PROFILE, PROFILE (SHOTPARTY_PROFILE
# wins over the config), REGION, PREFIX and ALERT_EMAIL. Exits with the config's problems if invalid.
load_config() {
  local out
  out="$(cd "$ROOT" && npx --no-install tsx scripts/config-env.ts)" || exit 1
  eval "$out"
}

# Like load_config, plus the `sam deploy` arguments for one stack, built from the config and the
# live account: STACK_NAME, PARAM_OVERRIDES (array) and TAGS (array). Usage: load_deploy_params <data|app> <stage>
load_deploy_params() {
  local out
  out="$(cd "$ROOT" && npx --no-install tsx scripts/config-env.ts --deploy "$1" --stage "$2")" || exit 1
  eval "$out"
}

# Prints the account/identity the scripts are about to act on. When the profile is not the one in
# the config (a SHOTPARTY_PROFILE override), requires typing the account ID back, so nothing lands in
# the wrong account.
confirm_target_account() {
  local profile="$1" account arn
  account="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
  arn="$(aws sts get-caller-identity --profile "$profile" --query Arn --output text)"
  echo "==> Target: profile=$profile account=$account"
  echo "    as $arn"
  if [[ "$profile" != "${CONFIG_PROFILE:-}" ]]; then
    local answer
    read -r -p "    Non-default profile. Type the account ID to continue: " answer
    [[ "$answer" == "$account" ]] || { echo "Aborted." >&2; exit 1; }
  fi
}

# A distribution on a CloudFront flat-rate plan (Stage 11) can't be deleted until the plan is
# canceled in the console; the plan's web ACL is named "CreatedByCloudFront-…". Warn and ask.
confirm_no_pricing_plan() {
  local profile="$1" dist="$2" answer
  [[ -n "$(plan_web_acl "$profile" "$dist")" ]] || return 0
  cat <<MSG
==> Distribution $dist is on a CloudFront flat-rate (Free) plan. CloudFront refuses to delete it
    until the plan is canceled: CloudFront console -> Distributions -> $dist -> Pricing plan ->
    Cancel (Free plans cancel immediately). Afterwards, before redeploying this stage:
      - the recreated distribution gets a NEW *.cloudfront.net domain: deploy app, then data again
        (both pick up the new domain automatically), update the Cloudflare widget hostnames,
        re-subscribe the Free plan and deploy app once more (its web ACL is picked up
        automatically), and make new QR codes (old ones will point at nothing)
MSG
  read -r -p "    Is the pricing plan canceled? [y/N] " answer
  [[ "$answer" == "y" ]] || { echo "Aborted." >&2; exit 1; }
}

# Prints the ARN of the flat-rate plan's web ACL on a distribution, or nothing if it has none.
plan_web_acl() {
  local profile="$1" dist="$2" acl
  [[ -z "$dist" || "$dist" == "None" ]] && return 0
  acl="$(aws cloudfront get-distribution-config --id "$dist" --profile "$profile" \
    --query 'DistributionConfig.WebACLId' --output text 2>/dev/null || true)"
  [[ "$acl" == *CreatedByCloudFront-* ]] && echo "$acl"
  return 0
}

# Deletes the plan's web ACL (from plan_web_acl) once its distribution is gone. Canceling the plan
# leaves the web ACL behind, outside any stack, where it may be billed as a standard web ACL.
delete_plan_web_acl() {
  local profile="$1" arn="$2" rest name id token
  [[ -n "$arn" ]] || return 0
  rest="${arn#*/webacl/}"
  name="${rest%%/*}"
  id="${rest#*/}"
  # CLOUDFRONT-scoped web ACLs live in us-east-1, whatever the stack region.
  token="$(aws wafv2 get-web-acl --scope CLOUDFRONT --name "$name" --id "$id" \
    --profile "$profile" --region us-east-1 --query LockToken --output text 2>/dev/null)" || {
    echo "==> Web ACL $name already deleted"
    return 0
  }
  echo "==> Deleting the plan's web ACL $name"
  aws wafv2 delete-web-acl --scope CLOUDFRONT --name "$name" --id "$id" --lock-token "$token" \
    --profile "$profile" --region us-east-1
}
