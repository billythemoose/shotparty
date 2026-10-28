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
# live account: STACK_NAME, PARAM_OVERRIDES (array) and TAGS (array).
# Usage: load_deploy_params <data|app> <stage>   or   load_deploy_params account
load_deploy_params() {
  local out args=(--deploy "$1")
  [[ "$1" == account ]] || args+=(--stage "$2")
  out="$(cd "$ROOT" && npx --no-install tsx scripts/config-env.ts "${args[@]}")" || exit 1
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

# Waits for a stack operation that was just started (execute-change-set, delete-stack) to finish,
# instead of the silent `aws cloudformation wait`. Prints each resource as it finishes, a note when
# a CloudFront distribution starts (the slow part), and, after a minute without news, what is still
# in progress, so logs and CI show progress. When stdout is a terminal (also under npm run setup,
# which hands it the terminal), a spinner with the elapsed time and the busy resources replaces
# those minute lines.
# Polls by stack ID, so a deleted stack still reports
# DELETE_COMPLETE. Fails if the stack doesn't end in <OP>_COMPLETE or takes over an hour (like
# `aws cloudformation wait`). Uses $PROFILE and $REGION.
# Usage: wait_stack <create|update|delete> <stack-name>
wait_stack() {
  local op="$1" stack="$2" expected id status seen newest pending
  local start=$SECONDS last_news=$SECONDS cloudfront_noted=false spin=false busy="starting"
  local event_id when res_status logical type reason line
  local -a fresh
  [[ -t 1 ]] && spin=true
  expected="$(tr '[:lower:]' '[:upper:]' <<<"$op")_COMPLETE"
  id="$(aws cloudformation describe-stacks --stack-name "$stack" --profile "$PROFILE" \
    --region "$REGION" --query 'Stacks[0].StackId' --output text 2>/dev/null)" || {
    # A delete of a nearly empty stack can finish before we look.
    [[ "$op" == delete ]] && return 0
    echo "error: stack $stack not found" >&2
    return 1
  }
  seen="$(aws cloudformation describe-stack-events --stack-name "$id" --profile "$PROFILE" \
    --region "$REGION" --no-paginate --query 'StackEvents[0].EventId' --output text)"
  echo "==> Waiting for $stack (${op}; progress below)"
  while :; do
    if $spin; then spin_for 10 "$start" "$busy"; else sleep 10; fi
    # Newest first; keep the events since the last poll and print them oldest first.
    fresh=()
    newest=""
    while IFS=$'\t' read -r event_id when res_status logical type reason; do
      [[ "$event_id" == "$seen" ]] && break
      [[ -z "$newest" ]] && newest="$event_id"
      fresh=("$when"$'\t'"$res_status"$'\t'"$logical"$'\t'"$type"$'\t'"$reason" "${fresh[@]+"${fresh[@]}"}")
    done < <(aws cloudformation describe-stack-events --stack-name "$id" --profile "$PROFILE" \
      --region "$REGION" --no-paginate --output text --query \
      'StackEvents[].[EventId,Timestamp,ResourceStatus,LogicalResourceId,ResourceType,ResourceStatusReason]')
    [[ -n "$newest" ]] && seen="$newest"
    for line in "${fresh[@]+"${fresh[@]}"}"; do
      IFS=$'\t' read -r when res_status logical type reason <<<"$line"
      [[ "$type" == AWS::CloudFormation::Stack ]] && continue
      if [[ "$res_status" == *_IN_PROGRESS ]]; then
        if [[ "$type" == AWS::CloudFront::Distribution ]] && ! $cloudfront_noted; then
          echo "    $logical: CloudFront is working on the distribution; this usually takes 5-20 min"
          cloudfront_noted=true
          last_news=$SECONDS
        fi
        continue
      fi
      # when is ISO 8601 (2026-10-27T05:52:01.123000+00:00): keep the UTC time of day.
      when="${when#*T}"
      printf '    %s  %-18s %s (%s)\n' "${when:0:8}" "$res_status" "$logical" "$type"
      [[ "$res_status" == *FAILED && "$reason" != None ]] && echo "      $reason"
      last_news=$SECONDS
    done

    status="$(aws cloudformation describe-stacks --stack-name "$id" --profile "$PROFILE" \
      --region "$REGION" --query 'Stacks[0].StackStatus' --output text)"
    if [[ "$status" != *_IN_PROGRESS ]]; then
      [[ "$status" == "$expected" ]] && return 0
      echo "error: $stack ended in $status (expected $expected)" >&2
      return 1
    fi
    if ((SECONDS - start >= 3600)); then
      echo "error: $stack still $status after 60 min; stopped waiting (check the console)" >&2
      return 1
    fi
    if $spin || ((SECONDS - last_news >= 60)); then
      # shellcheck disable=SC2016 # backticks are a JMESPath literal
      pending="$(aws cloudformation list-stack-resources --stack-name "$id" --profile "$PROFILE" \
        --region "$REGION" --output text --query \
        'StackResourceSummaries[?ends_with(ResourceStatus, `_IN_PROGRESS`)].LogicalResourceId')"
      pending="${pending//$'\t'/, }"
      pending="${pending//$'\n'/, }"
      busy="still in progress: ${pending:-$status}"
      $spin && continue
      echo "    ... $(((SECONDS - start) / 60))m elapsed, $busy"
      last_news=$SECONDS
    fi
  done
}

# Animates "<frame> 3m 07s <text>" on the terminal for about <seconds>, then clears the line, so
# nothing is left between the lines wait_stack prints. Usage: spin_for <seconds> <start> <text>
spin_for() {
  local end=$((SECONDS + $1)) start="$2" text="$3" cols i=0 elapsed line
  local -a frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  cols="$(stty size 2>/dev/null </dev/tty | cut -d' ' -f2)"
  # Some pseudo-terminals (script, CI runners) report 0 columns.
  [[ "$cols" =~ ^[0-9]+$ ]] && ((cols >= 20)) || cols=80
  while ((SECONDS < end)); do
    sleep 0.2
    elapsed=$((SECONDS - start))
    line="${frames[i % 10]} $((elapsed / 60))m $(printf '%02d' $((elapsed % 60)))s  $text"
    # Cut to the terminal width: a wrapped line can't be redrawn in place.
    printf '\r\033[K    %s' "${line:0:cols-5}"
    i=$((i + 1))
  done
  printf '\r\033[K'
}
