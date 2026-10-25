# 0002: Use the CloudFront Free flat-rate plan for WAF

- **Status:** Accepted (2026-09-26, Stage 11)
- **Deciders:** organizer, Claude

## Context

The upload API is public: anyone holding the link can call it. Request floods need to be stopped
before they reach Lambda, and the project's hard constraint is cost: it should run at about
$0/month outside an event.

The usual answer, a standalone AWS WAF web ACL, costs $5/month plus $1 per rule, more than
everything else combined. WAF Bot Control ($10/month and up) and WAF CAPTCHA (CloudFront Pro plan,
$15/month) cost more still.

CloudFront's **Free flat-rate plan** includes a web ACL with an IP rate-based rule and AWS managed
rule groups, plus 1M requests, 100 GB of transfer and a 5 GB S3 credit a month, for $0.

## Decision

Subscribe each stage's distribution to the Free plan and use its web ACL:

- an IP rate rule of 3,000 requests / 5 minutes (a whole venue can share one public IP);
- the AWS IP-reputation, Common and Known-bad-inputs managed groups, all enforcing.

Behind it, as a second cap that doesn't depend on the plan: API Gateway throttling (50 rps,
burst 100 per route) and reserved concurrency on every Lambda. Human verification is Cloudflare
Turnstile (free) instead of WAF CAPTCHA.

Direct calls to the `execute-api` URL would skip the WAF, so a CloudFront Function stamps an
`x-origin-verify` secret on `/api/*`, and the Lambdas answer 403 without it.

## Consequences

- WAF at $0, but the plan **has no API**: subscribing is a console step per distribution, and
  setup can only detect it and attach whatever web ACL is there (the `WebAclArn` parameter keeps
  the association from drifting on redeploy).
- The plan rejects `PriceClass`, so the template doesn't set one.
- A distribution on the plan **can't be deleted** until the plan is canceled in the console.
  `delete-app.sh` and `teardown-stage.sh` detect the plan and stop until it's canceled.
- New plans start every rule in Count mode; they have to be switched to Block by hand.

## Evidence

- Stage 11: a 50-connection flood (~490 rps) got 1,444 × 200 (the API cap) and 8,352 × 429 at
  API Gateway, never reaching Lambda; direct `execute-api` calls got 403.
- Stage 11: the first deploy with the plan rolled back on `PriceClass`; after removing it, drift
  was `IN_SYNC`.
- Stage 15: 300 simulated uploads through the enforcing WAF, 0 blocks.
- The WAF rate rule itself was verified by configuration, not by flood (that would have blocked
  the organizer's home IP).
