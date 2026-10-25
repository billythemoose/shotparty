#!/usr/bin/env bash
# Black-box checks that the upload gate refuses what it should. Run against a deployed stage.
#
#   scripts/abuse-tests.sh <dev|prod> gate    --open <token> --pin <pin> --closed <token>
#   scripts/abuse-tests.sh <dev|prod> session --open <token> --pin <pin> [--kill-switch]
#   scripts/abuse-tests.sh <dev|prod> turnstile --open <token> --pin <pin>
#   scripts/abuse-tests.sh <dev|prod> quota   --open <token> --pin <pin> --files <n>
#   scripts/abuse-tests.sh <dev|prod> direct  --open <token> --pin <pin>
#
#   gate       /api/session refuses bad tokens, PINs and closed events (needs the Turnstile TEST
#              secret, because every check spends a Turnstile token)
#   session    /api/presign refuses missing/forged/tampered sessions (dev: minted session); --kill-switch also flips
#              /<prefix>/<stage>/uploads_enabled off and on (dev only, ~70 s)
#   turnstile  with a REAL Turnstile secret: a dummy token is refused (proves the check is live)
#   quota      against an event created with --session-files <n> (small!): n presigns succeed,
#              the next is refused 429 session-quota; a second session has its own allowance
#              (sessions come from scripts/mint-session.ts, so any Turnstile secret works; dev only)
#   direct     calls that bypass CloudFront (the raw execute-api URL) are refused 403, even with a
#              valid session and forged CloudFront headers
set -euo pipefail

STAGE="${1:-}"
SUITE="${2:-}"
shift 2 || true
OPEN="" PIN="" CLOSED="" KILL=false FILES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --open) OPEN="$2"; shift ;;
    --pin) PIN="$2"; shift ;;
    --closed) CLOSED="$2"; shift ;;
    --kill-switch) KILL=true ;;
    --files) FILES="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
load_config
usage() { sed -n '4,8p' "$0" | sed 's/^#  //' >&2; exit 1; }
[[ "$STAGE" =~ ^(dev|prod)$ && "$SUITE" =~ ^(gate|session|turnstile|quota|direct)$ ]] || usage
[[ "$SUITE" != "quota" || ( "$FILES" -ge 1 && "$FILES" -le 50 ) ]] || { echo "quota needs --files 1..50" >&2; exit 1; }
[[ -n "$OPEN" && -n "$PIN" ]] || { echo "--open and --pin are required" >&2; exit 1; }
[[ "$SUITE" != "gate" || -n "$CLOSED" ]] || { echo "gate needs --closed" >&2; exit 1; }
if $KILL && [[ "$STAGE" != "dev" ]]; then echo "--kill-switch is dev-only" >&2; exit 1; fi

aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
confirm_target_account "$PROFILE"

SITE="$(aws_ cloudformation describe-stacks --stack-name "${PREFIX}-${STAGE}-app" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)"
DUMMY_TURNSTILE="XXXX.DUMMY.TOKEN.XXXX" # Cloudflare's test-mode token

declare -i passed=0 failed=0
LAST_BODY=""
# post <path> <expected-status> <expected-error|-> <label> <json-body> [authorization]
post() {
  local path="$1" want_status="$2" want_error="$3" label="$4" body="$5" auth="${6:-}" out status error
  local args=(-s -w $'\n%{http_code}' -X POST "$SITE$path" -H 'content-type: application/json' -d "$body")
  [[ -n "$auth" ]] && args+=(-H "authorization: $auth")
  out="$(curl "${args[@]}")"
  status="${out##*$'\n'}"
  LAST_BODY="${out%$'\n'*}"
  error="$(printf '%s' "$LAST_BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error","-"))' 2>/dev/null || echo '?')"
  if [[ "$status" == "$want_status" && ( "$want_error" == "-" || "$error" == "$want_error" ) ]]; then
    passed+=1; printf 'PASS  %-40s %s %s\n' "$label" "$status" "$error"
  else
    failed+=1; printf 'FAIL  %-40s got %s %s, want %s %s\n' "$label" "$status" "$error" "$want_status" "$want_error"
  fi
}
# Sessions for the session/quota suites are minted directly (dev test helper), so they work with
# the real Turnstile secret configured.
mint() { (cd "$ROOT" && SHOTPARTY_PROFILE="$PROFILE" npm run -s session:mint -- --stage "$STAGE" --event "$OPEN"); }
session_body() { printf '{"eventToken":"%s","turnstileToken":"%s"%s}' "$1" "$DUMMY_TURNSTILE" "${2:+,\"pin\":\"$2\"}"; }
file='{"filename":"a.jpg","contentType":"image/jpeg","size":1000}'

case "$SUITE" in
gate)
  echo "==> /api/session gate checks against $SITE (Turnstile TEST secret expected)"
  post /api/session 400 missing-event "no event token"               "{\"turnstileToken\":\"$DUMMY_TURNSTILE\"}"
  post /api/session 404 unknown-event "malformed token"               "$(session_body 'not_a-valid!token')"
  post /api/session 403 -             "path traversal (WAF blocks)"   "$(session_body '../../etc')"
  post /api/session 404 unknown-event "unknown (well-formed) token"   "$(session_body ZZZZZZZZZZZZZZZZZZZZZZ)"
  post /api/session 403 pin-required  "open event, no PIN"            "$(session_body "$OPEN")"
  post /api/session 403 wrong-pin     "open event, wrong PIN"         "$(session_body "$OPEN" 000000x)"
  post /api/session 200 -             "open event, right PIN"         "$(session_body "$OPEN" "$PIN")"
  post /api/session 403 closed        "closed event"                  "$(session_body "$CLOSED")"
  post /api/session 403 verification-failed "no Turnstile token"      "{\"eventToken\":\"$OPEN\",\"pin\":\"$PIN\"}"
  ;;
session)
  echo "==> /api/presign session checks against $SITE"
  SESSION="$(mint)"
  IFS=. read -r v id exp sig <<<"$SESSION"
  flip() { [[ "${1: -1}" == "A" ]] && printf '%sB' "${1%?}" || printf '%sA' "${1%?}"; }
  post /api/presign 401 session-required "no session"                "$file"
  post /api/presign 401 invalid-session  "garbage session"           "$file" "Bearer v1.nope"
  post /api/presign 401 invalid-session  "tampered signature"        "$file" "Bearer $v.$id.$exp.$(flip "$sig")"
  post /api/presign 401 invalid-session  "extended expiry"           "$file" "Bearer $v.$id.$((exp + 86400)).$sig"
  post /api/presign 401 invalid-session  "swapped session id"        "$file" "Bearer $v.AAAAAAAAAAAAAAAAAAAAAA.$exp.$sig"
  post /api/presign 200 -                "valid session"             "$file" "Bearer $SESSION"
  if $KILL; then
    param="/${PREFIX}/${STAGE}/uploads_enabled"
    restore() { aws_ ssm put-parameter --name "$param" --value true --overwrite >/dev/null; }
    trap restore EXIT
    echo "==> Kill switch: $param=false (cached up to 30 s)"
    aws_ ssm put-parameter --name "$param" --value false --overwrite >/dev/null
    sleep 35
    post /api/presign 503 uploads-disabled "existing session, kill switch off" "$file" "Bearer $SESSION"
    echo "==> Restoring $param=true"
    restore
    trap - EXIT
    sleep 35
    post /api/presign 200 -                "existing session, switch back on"  "$file" "Bearer $SESSION"
  fi
  ;;
quota)
  echo "==> /api/presign quota checks against $SITE (event limit: $FILES files per session)"
  SESSION="$(mint)"
  for ((i = 1; i <= FILES; i++)); do
    post /api/presign 200 -           "presign $i of $FILES"          "$file" "Bearer $SESSION"
  done
  post /api/presign 429 session-quota "presign $((FILES + 1)) (over the limit)" "$file" "Bearer $SESSION"
  SESSION2="$(mint)"
  post /api/presign 200 -             "second session has its own quota" "$file" "Bearer $SESSION2"
  ;;
direct)
  API="$(aws_ cloudformation describe-stacks --stack-name "${PREFIX}-${STAGE}-app" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
  echo "==> Direct execute-api calls must be refused ($API)"
  SESSION="$(mint)"
  forged=(-H 'x-origin-verify: guess' -H 'x-viewer-ip: 1.2.3.4')
  direct() {
    local label="$1" want="$2" status
    shift 2
    status="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
    if [[ "$status" == "$want" ]]; then passed+=1; printf 'PASS  %-40s %s\n' "$label" "$status"
    else failed+=1; printf 'FAIL  %-40s got %s, want %s\n' "$label" "$status" "$want"; fi
  }
  direct "event info, direct"            403 "$API/api/event/$OPEN"
  direct "session, direct + forged hdrs" 403 -X POST "$API/api/session" "${forged[@]}" \
    -H 'content-type: application/json' -d "$(session_body "$OPEN" "$PIN")"
  direct "presign, direct + valid session" 403 -X POST "$API/api/presign" "${forged[@]}" \
    -H "authorization: Bearer $SESSION" -H 'content-type: application/json' -d "$file"
  direct "same presign via CloudFront"   200 -X POST "$SITE/api/presign" \
    -H "authorization: Bearer $SESSION" -H 'content-type: application/json' -d "$file"
  direct "health stays open (monitoring)" 200 "$API/api/health"
  ;;
turnstile)
  echo "==> Real Turnstile secret: a dummy token must be refused ($SITE)"
  post /api/session 403 verification-failed "dummy Turnstile token" "$(session_body "$OPEN" "$PIN")"
  ;;
esac

echo "==> passed=$passed failed=$failed"
[[ $failed -eq 0 ]]
