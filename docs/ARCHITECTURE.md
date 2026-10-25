# shotparty: Architecture

> For how each subsystem works inside, with diagrams and code references, see [how-it-works/](how-it-works/README.md). The decisions behind the design are in [adr/](adr/README.md).

## Overview

Guests at an event scan a QR code and upload full-quality photos and videos from their phone browser into storage the organizer owns. They need no app and no account. Everything runs serverless in one AWS account, and the design target is minimal cost: a typical event (~100–200 guests, ~15–25 GB) costs about $1–$2/month while live.

```
Guest phone ──QR──> https://<distribution>.cloudfront.net/e/<eventToken>
        │
        ▼
CloudFront (Free flat-rate plan: CDN + WAF + TLS)
   ├── /*       → S3 site bucket (OAC, private)              static upload page
   └── /api/*   → API Gateway HTTP API → Lambdas              event, session, presign
                                   │
                                   ├── DynamoDB: events, sessions, quota counters, rejects
                                   ├── SSM: secrets, kill switch
                                   └── returns an S3 presigned POST per file
        │
        ▼  (the browser uploads bytes directly to S3, not through Lambda)
S3 media bucket   uploads/<eventId>/<guest-slug>/<uuid>.<ext>
        │  EventBridge "Object Created"
        ▼
Lambda validate: read the first bytes → magic-byte check → copy to accepted/ or delete
```

## Components

| Piece | What it is |
|---|---|
| **Data stack** (`<prefix>-<stage>-data`) | S3 media bucket (private, versioned with noncurrent versions expiring after 30 days, TLS-only, CORS for the site only, EventBridge events, optional Glacier Instant Retrieval archive of `accepted/` via `ArchiveAfterDays`) and a DynamoDB single table (on-demand, PITR, TTL, deletion protection). Names are published to SSM. |
| **App stack** (`<prefix>-<stage>-app`) | CloudFront on the Free flat-rate plan → private site bucket (OAC) and HTTP API. Five Lambdas (Node 22, arm64, esbuild bundles): `health`, `event`, `session`, `presign`, `validate`. CloudFront Functions, an SNS alerts topic, 7 CloudWatch alarms, 3 log metric filters, and optionally the account budget. |
| **Secrets** (SSM) | `turnstile_secret`, `session_key` (SecureString), `origin_verify`, `alert_email` (String). Created by `scripts/bootstrap-secrets.sh`, or for `turnstile_secret` by `npm run setup` from the Cloudflare API. Never in git. |
| **Static site** | Vite + TypeScript, mobile-first. One file picker for all photo and video types, concurrent uploads with per-file progress and retries, and a "Your name" field. Built and synced to the site bucket by `scripts/deploy.sh`, followed by a CloudFront invalidation. |
| **Organizer tools** | Local scripts: `event:create` / `event:update` / `event:close` (with QR codes), `gallery` (a local page of presigned links), `download` (MD5-verified), `uploads.sh` (kill switch), `sync-to-drive.sh`, and load, abuse and recovery tooling. See [operations.md](operations.md). |

Configuration lives in `shotparty.config.json` (schema: `shotparty.config.schema.json`): the AWS profile, region and resource prefix, per-stage settings, upload limits and events.

## Request flow

1. **`GET /api/event/{token}`**: the page learns the event name, whether a PIN is needed, whether the event is open or closed, and the Turnstile site key.
2. **`POST /api/session`**: **Turnstile first** (siteverify with the real viewer IP; hostname and action enforced), **then** the gate: kill switch → token → window → PIN (scrypt, constant-time). It returns an HMAC-signed 12 h session stored as `SESSION#<id>`. Every PIN guess costs a human verification.
3. **`POST /api/presign`** (Bearer session):
   - The origin check (CloudFront only) and the session signature and expiry check need no DB read.
   - Then the session record, body validation (allow-listed types including camera RAW, ≤ 1 GiB by default via `uploads.maxFileGb`, a guest-name slug), and the event window plus kill switch are re-checked.
   - **Quota reservation:** three single-item conditional updates (event total, IP-hour, session), rolled back when one is full.
   - Then a presigned POST pinned to the exact key, content type and **exact byte size**, valid for 10 minutes.
4. **Browser → S3** directly: `uploads/<eventId>/<guest-slug>/<uuid>.<ext>`.
5. **`validate`** (EventBridge `Object Created`) reads the first 64 bytes. ISO-BMFF files are judged by their major brand, so AVIF and M4A are rejected. Real media is **copied to `accepted/…` and the exact upload version deleted**; anything else is deleted and recorded as `REJECT#<event>`. A guest's repeat upload of the same file (same MD5, same guest folder) is deleted instead of copied. Duplicate event deliveries are no-ops, and `scripts/reprocess-uploads.sh` recovers anything stranded.

**Client IP:** API Gateway only sees CloudFront, so a CloudFront Function stamps `x-viewer-ip` plus the `x-origin-verify` secret. Lambdas trust the IP only with the secret, and direct execute-api calls get 403. IPv6 is bucketed per /64, and counters store HMACs, never IPs.

## Abuse protection

Nothing public can be made fully bot-proof. The goal is to make scripted abuse impractical and to **hard-bound the worst case** so abuse can never become a big bill. The layers, in the order a request meets them:

| # | Layer | What it stops |
|---|---|---|
| 1 | **Edge and compute throttles:** the CloudFront Free plan's WAF (IP rate limit 3,000 requests / 5 min plus AWS managed rule groups), HTTP API throttling (50 rps, burst 100 per route), and per-Lambda reserved concurrency (presign 100, validate 50, session and event 25, health 5). | Request floods; also caps the API and Lambda bill |
| 2 | **Unguessable event token** in the QR URL (128-bit random). Optionally, a **PIN** printed on the card but not in the QR, so a photo of the QR alone isn't enough. | Scanners and crawlers that never saw the QR |
| 3 | **Cloudflare Turnstile**, verified server-side before a session is issued. | Headless scripts and simple bots |
| 4 | **Signed session** (12 h, HMAC, recorded in DynamoDB), required on every presign. | Replaying one human check across many bots |
| 5 | **Quotas** as DynamoDB conditional counters. Defaults: 500 files / 10 GiB per session (install-wide in the config's `uploads` section), 3,000 files/hour per IP (a venue shares one IP), 20,000 files / 100 GiB per event; overridable per event with `event:create` or `event:update`. | One guest or bot filling storage; caps the total damage |
| 6 | **Presigned POST policy per file:** server-chosen key, exact content type and byte size, 10-minute expiry. The media bucket blocks public access and allows CORS from the site only. | Oversized files, overwriting others' files, arbitrary paths, reusing links later |
| 7 | **Post-upload validation** by magic bytes (JPEG, PNG, HEIC/HEIF, WebP, MP4/MOV, and camera RAW: TIFF-based DNG/CR2/NEF/ARW/ORF/RW2, Fujifilm RAF, CR3). | Junk, executables, and archives renamed as media |
| 8 | **Upload window and kill switch:** each event's `openFrom`/`openUntil`, plus the SSM parameter `/<prefix>/<stage>/uploads_enabled`, checked on every session and presign. | Abuse after the event; instant shutdown |
| 9 | **Cost circuit breakers:** CloudWatch alarms (Lambda errors and throttles, API 5xx, presign spike, rejected uploads, quota exceeded, Turnstile failures) emailing through SNS, including on recovery, and an account budget ($15/month; email at $5 and $15 actual, $15 forecast). | Surprises of any kind |

**Worst case:** S3 doesn't charge for inbound data, so filling the 100 GiB event cap costs about $2.30/month in storage until the junk is deleted. The realistic risk is nuisance content, not a large bill; validation plus the organizer's review in the gallery handles it.

## Deployment: two stacks

Templates are **AWS SAM** (`infra/*/template.yaml`): plain CloudFormation plus the `AWS::Serverless` transform, which packages the Lambda code. `scripts/deploy.sh` reads `shotparty.config.json`, deploys the data stack, then the app stack, then syncs the site. Each stage (`dev`, `prod`) is a fully separate pair of stacks in the same account.

| Stack | Contains | Changes | Protection |
|---|---|---|---|
| `<prefix>-<stage>-data` | Media bucket, DynamoDB table | Rarely | Termination protection; a **stack policy** (`infra/data/stack-policy.json`) denying `Update:Replace` and `Update:Delete` on the bucket and table; `DeletionPolicy` and `UpdateReplacePolicy: Retain`; S3 versioning; DynamoDB deletion protection and PITR |
| `<prefix>-<stage>-app` | Lambdas, HTTP API, CloudFront, site bucket, alarms, budget | Every iteration | Freely redeployable; deleting and recreating it is safe for data |

- **Wiring:** the data stack writes the bucket and table names and ARNs to **SSM parameters**; the app stack reads them with `AWS::SSM::Parameter::Value<String>` parameters. CloudFormation `Export`/`ImportValue` isn't used, because exports lock both stacks and block edits.
- **Replacement-safe rules for the data stack:**
  - Don't hard-code `BucketName` or `TableName`; CloudFormation generates them.
  - Never edit properties that force replacement (table key schema, bucket name).
  - Add new indexes and lifecycle rules as in-place updates.
  - Review every change set for `Replacement: True` before executing it (`scripts/changeset-guard.ts`).
- **Secrets** are SSM SecureStrings, created outside CloudFormation (which can't create them) and read by the Lambdas at cold start. This is free, where Secrets Manager costs $0.40 per secret per month.
- **CloudFront Free plan:** the distribution sets no `PriceClass` (the plan rejects it), and its web ACL is attached through the app stack parameter `WebAclArn`, so redeploys don't drop it through drift. The plan must be canceled in the console before the distribution can be deleted; the teardown scripts check for this.
- **Lambda concurrency:** reserved concurrency totals 205 per stage, and Lambda keeps 100 unreserved, so the account's concurrent-executions quota must be raised above the new-account default (Service Quotas).
- **Account setup** (single account, or a hardened member account with a region-deny SCP) is in [aws-setup.md](aws-setup.md).

## Design choices

- **Presigned POST, not PUT:** a POST policy is **enforced by S3** for the exact key, content type and size. A presigned PUT doesn't reliably enforce size. A single POST handles files up to 5 GB, so there is no multipart upload; the tradeoff is no mid-file resume, which is fine for phone media.
- **API Gateway HTTP API, not a Lambda Function URL:** it provides free per-route throttling and avoids the OAC payload-signing complication Function URLs have with POST bodies.
- **EventBridge, not S3 → Lambda notifications:** the bucket lives in the data stack and the Lambda in the app stack, and an S3 notification would create a cross-stack dependency cycle.
- **No DynamoDB transactions for quotas:** the shared event and IP counters cause `TransactionConflict` under load, so each counter is a single-item conditional update with explicit rollback ([ADR 0003](adr/0003-no-dynamodb-transactions.md)).
- **No custom domain:** the QR code uses the CloudFront domain. Recreating the prod app stack changes that domain, so it must not be recreated between printing the cards and the end of the upload window.
- **One Turnstile widget per install**, shared by dev and prod (both hostnames). Session keys and origin secrets are per stage.

## Cost

| Item | Cost (~25 GB event) |
|---|---|
| CloudFront Free plan (CDN, WAF, TLS, 1M requests / 100 GB, 5 GB S3 credit) | $0 |
| S3 Standard, 25 GB (minus the 5 GB credit) | ~$0.46/month |
| S3 requests (a few thousand POST/GET) | < $0.05 |
| API Gateway HTTP API, Lambda, DynamoDB on-demand | pennies |
| Inbound upload transfer | free |
| Downloading everything once (first 100 GB/month of egress free) | $0 |
| CloudWatch alarms: 13 alarm metrics per stage (the errors and throttles alarms sum 5 and 3 functions), first 10 per account free | ~$0.30 for one stage, ~$1.60 for dev + prod |
| Log metric filters: 3 custom metrics per stage, published only when they match (first 10 free) | $0 |
| **Total** | **≈ $1–$2/month** while live. Afterwards, storage drops to ~$0.10 with `ArchiveAfterDays` (Glacier Instant Retrieval), or to $0 after download and delete; the alarms remain until the stage is torn down |

Paid options deliberately not used: WAF CAPTCHA (needs the $15/month CloudFront Pro plan), WAF Bot Control ($10/month+), a standalone WAF web ACL ($5/month + $1/rule), Secrets Manager, and a custom domain.

## Sources

- [CloudFront flat-rate plans (Free plan features, allowances, eligibility)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)
- [S3 presigned POST vs PUT (size enforcement)](https://advancedweb.hu/differences-between-put-and-post-s3-signed-urls/) · [securing S3 presigned URLs](https://insecurity.blog/2021/03/06/securing-amazon-s3-presigned-urls/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [AWS WAF pricing](https://wafpricing.com/aws-waf-pricing) · [S3 pricing](https://aws.amazon.com/s3/pricing/)
- [AWS Organizations member-account best practices](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_member-acct.html) · [SCP examples](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps_examples.html)
