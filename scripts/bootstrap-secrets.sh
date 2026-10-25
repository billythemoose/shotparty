#!/usr/bin/env bash
# Creates the stage's SecureString secrets in SSM (CloudFormation can't create SecureStrings):
#   /<prefix>/<stage>/turnstile_secret  Cloudflare Turnstile secret key (prompted, never echoed)
#   /<prefix>/<stage>/session_key       random HMAC key for upload sessions (generated)
#   /<prefix>/alert_email               where alarms and budget alerts are emailed (account-wide;
#                                       from alerts.email in shotparty.config.json, else prompted)
#   /<prefix>/<stage>/origin_verify     random value CloudFront adds to /api/* requests so the API
#                                       can tell them from direct calls (a String, because
#                                       CloudFormation reads it into the CloudFront Function)
#
# Usage: scripts/bootstrap-secrets.sh <dev|prod> [--set-turnstile-secret | --turnstile-test-secret]
#                                     [--rotate-session-key]
# Safe to re-run: existing values are kept unless a flag says otherwise.
# Unattended (SHOTPARTY_NONINTERACTIVE=1, used by npm run setup): never prompts. The Turnstile
# secret then comes from the TURNSTILE_SECRET env var (never argv), and the alert email from the config.
#   --set-turnstile-secret   prompt for (and replace) the Turnstile secret; asked anyway if missing
#   --turnstile-test-secret  use Cloudflare's always-pass test secret (dev only)
#   --skip-turnstile-secret  leave the Turnstile secret alone (npm run setup writes it itself when it
#                            manages the widget through the Cloudflare API)
#   --rotate-session-key     replace an existing session key (logs out every guest session)
#   --set-alert-email        prompt for (and replace) the alert email address
set -euo pipefail

STAGE="${1:-}"
shift || true
TEST_SECRET=false
SET_TURNSTILE=false
SKIP_TURNSTILE=false
SET_EMAIL=false
ROTATE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --turnstile-test-secret) TEST_SECRET=true ;;
    --set-turnstile-secret) SET_TURNSTILE=true ;;
    --skip-turnstile-secret) SKIP_TURNSTILE=true ;;
    --set-alert-email) SET_EMAIL=true ;;
    --rotate-session-key) ROTATE=true ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
[[ "$STAGE" =~ ^(dev|prod)$ ]] || { echo "usage: $0 <dev|prod> [--set-turnstile-secret | --turnstile-test-secret] [--rotate-session-key]" >&2; exit 1; }
if $TEST_SECRET && [[ "$STAGE" != "dev" ]]; then echo "--turnstile-test-secret is dev-only" >&2; exit 1; fi

confirm_target_account "$PROFILE"

# Values go through a private temp file, not argv, so they never appear in the process list.
TMP="$(mktemp)"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT
put_secure() {
  local name="$1" value="$2" overwrite="$3"
  NAME="$name" VALUE="$value" OVERWRITE="$overwrite" python3 -c '
import json, os
print(json.dumps({"Name": os.environ["NAME"], "Value": os.environ["VALUE"], "Type": "SecureString",
                  "Overwrite": os.environ["OVERWRITE"] == "true",
                  "Description": "shotparty secret (scripts/bootstrap-secrets.sh)"}))' >"$TMP"
  aws ssm put-parameter --cli-input-json "file://$TMP" --profile "$PROFILE" --region "$REGION" >/dev/null
  : >"$TMP"
}
exists() { aws ssm get-parameter --name "$1" --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; }

# Turnstile secret: kept if present, unless asked to replace it.
TS_PARAM="/${PREFIX}/${STAGE}/turnstile_secret"
if $SKIP_TURNSTILE; then
  echo "==> $TS_PARAM: managed by npm run setup (Cloudflare API), skipped here"
elif exists "$TS_PARAM" && ! $SET_TURNSTILE && ! $TEST_SECRET; then
  echo "==> $TS_PARAM: already exists, kept (use --set-turnstile-secret to replace)"
else
  if $TEST_SECRET; then
    SECRET="1x0000000000000000000000000000000AA"
    echo "==> $TS_PARAM: Cloudflare always-pass TEST secret"
  elif [[ -n "${TURNSTILE_SECRET:-}" ]]; then
    SECRET="$TURNSTILE_SECRET"
    [[ ${#SECRET} -ge 20 ]] || { echo "TURNSTILE_SECRET doesn't look like a Turnstile secret." >&2; exit 1; }
    echo "==> $TS_PARAM: from the TURNSTILE_SECRET env var"
  elif [[ "${SHOTPARTY_NONINTERACTIVE:-}" == "1" ]]; then
    echo "error: $TS_PARAM is missing. Set TURNSTILE_SECRET=<secret key> (Cloudflare dashboard -> Turnstile -> your widget) and run again." >&2
    exit 1
  else
    read -r -s -p "Turnstile secret key for $STAGE (input hidden): " SECRET
    echo
    [[ ${#SECRET} -ge 20 ]] || { echo "That doesn't look like a Turnstile secret." >&2; exit 1; }
  fi
  put_secure "$TS_PARAM" "$SECRET" true
  unset SECRET
  echo "    set"
fi

# Session key: generate once; rotating it invalidates every issued session.
SK_PARAM="/${PREFIX}/${STAGE}/session_key"
if exists "$SK_PARAM" && ! $ROTATE; then
  echo "==> $SK_PARAM: already exists, kept (use --rotate-session-key to replace)"
else
  put_secure "$SK_PARAM" "$(openssl rand -base64 48 | tr -d '\n')" true
  echo "==> $SK_PARAM: generated (48 random bytes)"
fi
# Origin-verify secret: a plain String (CloudFormation dynamic references can't read SecureStrings
# into CloudFront Functions); only this account's admins can read it.
OV_PARAM="/${PREFIX}/${STAGE}/origin_verify"
if exists "$OV_PARAM"; then
  echo "==> $OV_PARAM: already exists, kept"
else
  NAME="$OV_PARAM" VALUE="$(openssl rand -hex 32)" python3 -c '
import json, os
print(json.dumps({"Name": os.environ["NAME"], "Value": os.environ["VALUE"], "Type": "String",
                  "Description": "shotparty CloudFront->API origin secret (scripts/bootstrap-secrets.sh)"}))' >"$TMP"
  aws ssm put-parameter --cli-input-json "file://$TMP" --profile "$PROFILE" --region "$REGION" >/dev/null
  : >"$TMP"
  echo "==> $OV_PARAM: generated (32 random bytes); deploy the app stack to apply it"
fi
# Alert email: account-wide (both stages alert the same person), a plain String.
EM_PARAM="/${PREFIX}/alert_email"
# The config (alerts.email) is the source of truth when it's set; otherwise prompt once.
CURRENT_EMAIL="$( (exists "$EM_PARAM" && aws ssm get-parameter --name "$EM_PARAM" --query Parameter.Value \
  --output text --profile "$PROFILE" --region "$REGION") || true)"
if [[ -n "$ALERT_EMAIL" && "$ALERT_EMAIL" == "$CURRENT_EMAIL" ]] && ! $SET_EMAIL; then
  echo "==> $EM_PARAM: matches the config, kept"
elif [[ -z "$ALERT_EMAIL" && -n "$CURRENT_EMAIL" ]] && ! $SET_EMAIL; then
  echo "==> $EM_PARAM: already exists, kept (use --set-alert-email to replace)"
else
  if [[ -n "$ALERT_EMAIL" ]] && ! $SET_EMAIL; then
    EMAIL="$ALERT_EMAIL"
  elif [[ "${SHOTPARTY_NONINTERACTIVE:-}" == "1" ]]; then
    echo "error: no alert email. Set alerts.email in shotparty.config.json and run again." >&2
    exit 1
  else
    read -r -p "Email address for alarms and budget alerts: " EMAIL
  fi
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || { echo "That doesn't look like an email address." >&2; exit 1; }
  NAME="$EM_PARAM" VALUE="$EMAIL" python3 -c '
import json, os
print(json.dumps({"Name": os.environ["NAME"], "Value": os.environ["VALUE"], "Type": "String", "Overwrite": True,
                  "Description": "shotparty alert recipient (scripts/bootstrap-secrets.sh)"}))' >"$TMP"
  aws ssm put-parameter --cli-input-json "file://$TMP" --profile "$PROFILE" --region "$REGION" >/dev/null
  : >"$TMP"
  echo "==> $EM_PARAM: set; deploy the app stack, then confirm the SNS subscription email"
fi
echo "Lambdas pick up changes within ~5 minutes (secrets cache)."
