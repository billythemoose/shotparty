# Security

## Reporting a vulnerability

Please report it privately through GitHub's **Report a vulnerability** button (the repository's
Security tab), not in a public issue. Include what an attacker can do and the steps to reproduce
it. You should get a reply within a week. Only the latest `main` is supported.

If you run your own install and think someone is abusing it right now, turn uploads off first
(`scripts/uploads.sh <stage> off`), then investigate.

## Threat model

shotparty is a public upload form. Anyone holding the QR code can open the page, and nothing
public can be made fully bot-proof. The design goals are:

1. Scripted abuse is impractical.
2. The worst case is **hard-bounded**, so abuse can't turn into a large bill or a full account.
3. Guests' files are private: only the organizer can read them.

**Assets:** the organizer's AWS bill and account, guests' photos, and the event's reputation (no
junk in the album).

**Trusted:** the organizer and their AWS credentials, AWS, and Cloudflare (Turnstile).
**Untrusted:** everything that reaches the public site or API, including real guests' phones.

### Layers, in the order a request meets them

| #   | Layer                               | What it stops                                                                                                                                                                                                                                   |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **CloudFront WAF** (Free plan)      | Request floods: an IP rate limit plus AWS managed rule groups, in front of both the page and the API.                                                                                                                                           |
| 2   | **Origin check**                    | Bypassing the WAF: the API only answers requests that came through CloudFront (a secret header). Direct `execute-api` calls get 403.                                                                                                            |
| 3   | **Secret event link**, optional PIN | Random scanners and crawlers: the link holds a 128-bit random token. The PIN is printed on the card but not in the QR code, so a photo of the QR code alone isn't enough. PINs are stored as scrypt hashes and compared in constant time.       |
| 4   | **Cloudflare Turnstile**            | Headless scripts: verified server-side (hostname and action enforced) before a session is issued, so every PIN guess also costs a human check.                                                                                                  |
| 5   | **Signed upload session** (12 h)    | Replaying one human check across many bots: an HMAC-signed token, also recorded in DynamoDB, required by every presign.                                                                                                                         |
| 6   | **Quotas** (conditional updates)    | One guest, network or bot filling storage: per session, per IP per hour (stored as an HMAC, never the IP) and per event, in files and bytes.                                                                                                    |
| 7   | **Presigned POST per file**         | Oversized files, overwrites and arbitrary paths: the key is chosen by the server, the content type is allow-listed, the size is pinned to the **exact** declared bytes, and the link expires in 10 minutes. The bucket is private and TLS-only. |
| 8   | **Content validation**              | Junk renamed as `.jpg`: a Lambda reads each file's first bytes. Real photos and videos move to `accepted/`; anything else is deleted and logged.                                                                                                |
| 9   | **Throttles**                       | Bills from request floods: API Gateway rate limits and reserved Lambda concurrency per function.                                                                                                                                                |
| 10  | **Upload window and kill switch**   | Abuse weeks after the event: uploads are refused outside the window, and one command turns them off within a minute.                                                                                                                            |
| 11  | **Alarms and a budget**             | Surprises: CloudWatch alarms and an AWS budget email the organizer.                                                                                                                                                                             |

The data (media bucket and table) lives in its own stack with retain policies, termination
protection and a stack policy that refuses replacement, so a bad deploy can't delete it. Secrets
live in SSM Parameter Store, never in the repository.

### Worst case

S3 doesn't charge for incoming data, and the event quota caps storage (100 GiB by default):
roughly **$2.30/month** until the junk is deleted. The realistic risk is a nuisance (unwanted but
valid photos in the album), which the organizer handles by reviewing the album.

### Known limits

- **Anyone with the QR code (and PIN) can upload.** That's the point of the product. A leaked code
  is handled by closing the event early or turning uploads off.
- **Content isn't moderated.** Validation checks that a file is a real photo or video, not what it
  shows.
- **The organizer's machine holds the keys.** Admin scripts use the organizer's AWS credentials.
  Use SSO with short sessions, and a dedicated AWS account (see `docs/aws-setup.md`).
- **The CloudFront domain is the event link.** Without a custom domain, recreating the app stack
  changes the URL on every printed card. This affects availability, not security.

A fuller write-up of each layer is in
[docs/how-it-works/abuse-protection.md](docs/how-it-works/abuse-protection.md).
