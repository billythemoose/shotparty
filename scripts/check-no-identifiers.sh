#!/usr/bin/env bash
# Fails if the repository contains anything that identifies a real install: AWS account IDs,
# CloudFront domains and distribution IDs, Free plan web ACL names, API IDs, Organization and
# Identity Center IDs, real Turnstile site keys, or email addresses. It checks tracked files plus
# new files that aren't ignored, so it catches a leak before the commit as well as in CI.
#
# The patterns are generic, so this file never contains a real value. To also block literal
# strings (your name, your domain, the real IDs), list them one per line in .identifiers.local
# (git-ignored); blank lines and lines starting with # are skipped.
#
# Usage: scripts/check-no-identifiers.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Lockfiles are full of hashes and version numbers; binaries are skipped with -I.
EXCLUDE=(':!package-lock.json')
found=0

indent() { while IFS= read -r line; do printf '    %s\n' "$line"; done <<<"$1"; }

# check <description> <PCRE> [allowed matches, as an ERE]
# git grep and grep exit 1 for "nothing matched"; anything above that is an error and must fail
# the check, not pass it.
check() {
  local what="$1" pattern="$2" allow="${3:-}" hits
  hits="$(git grep --untracked -nIoP "$pattern" -- . "${EXCLUDE[@]}")" || [[ $? -eq 1 ]]
  if [[ -n "$allow" && -n "$hits" ]]; then
    hits="$(grep -vE ":(${allow})\$" <<<"$hits")" || [[ $? -eq 1 ]]
  fi
  if [[ -n "$hits" ]]; then
    echo "✗ $what:"
    indent "$hits"
    found=1
  fi
}

# AWS documentation's example values are allowed.
check 'AWS account ID' '(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])' '111122223333|123456789012|000000000000'
check 'CloudFront domain' 'd[a-z0-9]{12,13}\.cloudfront\.net' 'd111111abcdef8\.cloudfront\.net'
check 'CloudFront distribution ID' '(?<![A-Za-z0-9_-])E(?=[A-Z]*[0-9])[A-Z0-9]{12,13}(?![A-Za-z0-9_-])' 'EDFDVBD6EXAMPLE'
check 'Free plan web ACL name' 'CreatedByCloudFront-[0-9a-f]{6,}'
check 'API Gateway ID' '[a-z0-9]{10}\.execute-api\.'
check 'Identity Center portal' 'd-[0-9a-f]{10}\.awsapps\.com'
check 'Organization / OU ID' '(?<![A-Za-z0-9-])(o-(?=[a-z]*[0-9])[a-z0-9]{10,32}|ou-[a-z0-9]{4,32}-[a-z0-9]{8,32})(?![A-Za-z0-9-])'
# Cloudflare's published test keys start 1x/2x/3x; the examples in tests and docs are allowed.
check 'Turnstile site key' '0x4AAAA[A-Za-z0-9_-]{8,}' '0x4AAAAAAAexample|0x4AAAAAAAREPLACE_ME'
check 'Email address' '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  '[^@]+@example\.(com|org|net)|(you|yourname)\+shotparty@gmail\.com|noreply@(anthropic\.com|github\.com)'

if [[ -f .identifiers.local ]]; then
  while IFS= read -r literal || [[ -n "$literal" ]]; do
    [[ -z "$literal" || "$literal" == \#* ]] && continue
    hits="$(git grep --untracked -nIiF -e "$literal" -- . "${EXCLUDE[@]}" ':!.identifiers.local')" ||
      [[ $? -eq 1 ]]
    if [[ -n "$hits" ]]; then
      echo "✗ denylisted string from .identifiers.local:"
      indent "$hits"
      found=1
    fi
  done <.identifiers.local
fi

if [[ "$found" -ne 0 ]]; then
  echo "Identifiers found. Replace them with placeholders (see CONTRIBUTING.md)." >&2
  exit 1
fi
echo "✓ No identifiers found."
