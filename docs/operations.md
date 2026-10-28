# Operations guide

Everything an organizer or developer runs after the [quick start](../README.md#quick-start): events,
the day itself, the post-event runbook, configuration, deploys and live testing. The design is in
[ARCHITECTURE.md](ARCHITECTURE.md); the decisions behind it are in [adr/](adr/README.md).

## Stages

Each stage (`dev`, `prod`) is a **data stack** (bucket and table; protected, never replaced) and an
**app stack** (everything else; safe to redeploy). See [ADR 0001](adr/0001-two-stack-split.md).
Use `dev` for testing. Guests use `prod`: **don't recreate its app stack after the QR cards are
printed**, because the CloudFront URL would change. The account-wide budget is a small third stack,
`<prefix>-account`, which lives as long as any stage does.

All commands use the AWS profile from `shotparty.config.json` (with SSO:
`aws sso login --profile <profile>`; sessions last 8 h).

## Organizer cheat sheet

```sh
# Events
npm run event:create -- --stage prod --name "Pizza & Games" \
  --open-from 2026-10-17T08:00:00-07:00 --open-until 2026-11-16T23:59:59-08:00 [--generate-pin] \
  [--headline … --welcome … --thanks … --accent-color "#rrggbb"]
                                          # prints the guest URL; writes qr-codes/<event>-prod.svg/.png
npm run event:create -- --stage prod --from-config <eventId>   # same, from the config's events[]
npm run event:update -- --stage prod --event-id <folder> --headline "Say cheese" \
  --welcome "…" --thanks "…" --accent-color "#1a5fb4"   # change the page; same URL and QR code
npm run event:update -- --stage prod --event-id <folder> --clear all    # back to neutral defaults
npm run event:update -- --stage prod --event-id <folder> --session-gb 50 --session-files 2000
                                          # raise quotas, e.g. for RAW shooters (also --event-gb, …)
npm run qr -- --url <guest-url> --name <file-name>        # regenerate a QR code
npm run event:close -- --stage prod --event-id <folder> [--until <iso>]  # close early / change end

# During the event
npm run gallery -- --stage prod                          # list event folders
npm run gallery -- --stage prod --event <folder>         # private local gallery (links ~6 h)
scripts/uploads.sh prod status|off|on [--event <token>]  # kill switch (in effect within 35 s)

# After the event
npm run download -- --stage prod --event <folder>        # photos/prod/<event>/… + manifest.csv, MD5-verified
scripts/sync-to-drive.sh prod <folder> gdrive:Events    # optional, needs rclone (not live-tested)
```

`qr-codes/`, `galleries/` and `photos/` are git-ignored: they contain the secret link or the photos.

## Before the event

1. `npm run event:create …` with the real name and window; print a test card and scan it from ~1 m
   in dim light. Print the PIN (if any) as text next to the QR code, never inside it.
2. `scripts/uploads.sh prod status` shows `true`; the alert emails arrive (both topics confirmed).
3. Optionally rerun the simulated guests (see below) and clean up afterwards.

## After the event (runbook)

1. `npm run download -- --stage prod --event <folder>` (re-run until 100% verified).
2. Optionally copy to Google Drive (`scripts/sync-to-drive.sh`).
3. Uploads close on their own at `--open-until`; to close early: `scripts/uploads.sh prod off`.
4. Optionally cut storage cost ~80%: set `"archiveAfterDays": 30` on the stage in `shotparty.config.json`
   (prod), then `scripts/deploy.sh data prod`.
5. Only once the window has closed: `scripts/delete-app.sh prod` (photos stay in the data stack).
6. Check the next bill (expected ~$0.10–$0.50/month).

## Configuration

Everything you provide lives in one git-ignored file, `shotparty.config.json`: the AWS profile,
region and name prefix, the alert email, the Cloudflare account ID (optional), and per stage the
Turnstile site key and archive settings, and the account budget's monthly limit
(`budgets.accountMonthlyUsd`, default $20; 0 = none). With `cloudflare.accountId` set, leave a stage's
`turnstileSiteKey` out and `npm run setup` fills it in (it needs `CLOUDFLARE_API_TOKEN`; until the
widget exists, deploys use Cloudflare's always-block test key, so the page fails closed). Start from `cp shotparty.config.example.json shotparty.config.json`. Every setting is
described in `shotparty.config.schema.json`, so editors autocomplete and check it. Secrets never go
in it: they're generated into, or prompted into, SSM by `scripts/bootstrap-secrets.sh`. The scripts
read the file from the repo root, or from `$SHOTPARTY_CONFIG`. `SHOTPARTY_PROFILE=<profile>` targets
another account for one run (you type the account ID back to confirm).

Any AWS account you can log in to works. For a dedicated member account behind a region-deny SCP,
follow the optional hardened path in [docs/aws-setup.md](aws-setup.md).

```sh
npm ci
npm run lint && npm run lint:infra && npm run lint:shell && npm run typecheck && npm test   # all checks (CI runs the same)
npm run test:e2e                  # browser tests of the guest page (Playwright; API, S3, Turnstile mocked)
npm run test:coverage             # tests plus a coverage summary; then npm run coverage:badge
npm start                         # local page on http://localhost:5173 (API_ORIGIN=<site> to proxy /api)
npm run build && npm run smoke --workspace api                         # bundles + ESM import smoke test
```

## Deploying

`npm run setup` runs everything below in order. The individual steps:

```sh
scripts/deploy.sh data <dev|prod>   # data stack (shows a change set; applies stack policy + protection)
scripts/deploy.sh app  <dev|prod>   # app stack + site (bundles, smoke-tests, change set)
scripts/deploy.sh site <dev|prod>   # page only (build, sync, CloudFront invalidation)
scripts/deploy.sh account           # the <prefix>-account stack (the account-wide budget)
scripts/bootstrap-secrets.sh <stage> [--set-turnstile-secret] [--set-alert-email] [--rotate-session-key]
```

Always review the change set; the data stack must never show `Replacement: True` (its stack policy
refuses it anyway). Unattended runs (`npm run setup -- --config …`, or `SHOTPARTY_ASSUME_YES=1`)
check every change set with `scripts/changeset-guard.ts` instead, and refuse to execute one that
would replace or delete anything in the data stack, or replace the CloudFront distribution (its
URL is in every printed QR code). `deploy.sh` builds the `sam deploy` arguments from the config plus the live
account (the site URL and the distribution's web ACL), so there is no `samconfig.toml` to edit. On a
stage's first deploy, run `data`, `app`, then `data` and `app` again, so both pick up the new site
URL. One-time console steps per stage (not in CloudFormation): subscribe the CloudFront distribution
to the **Free plan**, switch its WAF rules from monitor to block, then deploy `app` again (the web
ACL is picked up automatically). Add the site hostname to the Turnstile widget, unless setup
manages it (`cloudflare.accountId` plus `CLOUDFLARE_API_TOKEN`).

## Testing against a deployed stage

```sh
scripts/abuse-tests.sh dev gate|session|quota|direct|turnstile …    # black-box security checks
npm run load-test -- --stage prod --event <token> --allow-prod --guests 30 --files 10
npm run load-test -- --stage prod --event <token> --allow-prod --cleanup
scripts/reprocess-uploads.sh <stage> [--dry-run]    # re-validate anything stuck in uploads/
scripts/wipe-dev-data.sh                            # empty dev (events, files, records)
scripts/teardown-stage.sh <stage>                   # destroy a stage completely (asks twice)
```

`session:mint` / `load-test` create sessions without Turnstile using admin credentials; prod needs
an explicit `--allow-prod`.

## Troubleshooting

- **`Token has expired and refresh failed`**: run `aws sso login --profile <profile>`.
- **Guests see "Uploads are paused"**: the kill switch is off: `scripts/uploads.sh prod on`.
- **An alarm email**: every alarm also emails when it recovers; the description says what to check.
  Lambda logs: `aws logs tail /aws/lambda/<prefix>-prod-<function> --since 30m --profile <profile>`.
- **Files stuck in `uploads/`** (validator outage > 1 h): `scripts/reprocess-uploads.sh prod`.
