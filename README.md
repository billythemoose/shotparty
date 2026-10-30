# shotparty

[![CI](https://github.com/billythemoose/shotparty/actions/workflows/ci.yml/badge.svg)](https://github.com/billythemoose/shotparty/actions/workflows/ci.yml)
![coverage](.github/badges/coverage.svg)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A self-hosted QR-code photo drop for any event.** Guests scan a card, pick photos and videos on
their phone, and the files land at full quality in an S3 bucket in **your own AWS account**. No
app, no guest accounts, no subscription. A live event costs about $1–$2 a month, and an archived
one well under $1.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/guest-open-dark.png" />
    <img src="docs/images/guest-open-light.png" width="260" alt="The guest page for an event: name, headline, an optional name field and a Choose photos & videos button" />
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/guest-uploading-dark.png" />
    <img src="docs/images/guest-uploading-light.png" width="260" alt="Five files uploading: two done, three in progress, with an overall progress bar" />
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/guest-done-dark.png" />
    <img src="docs/images/guest-done-light.png" width="260" alt="All five files uploaded, with a thank-you message" />
  </picture>
</p>

Built and run for a real event: printed QR cards, guests on venue Wi-Fi and cellular, every photo
downloaded and checksum-verified afterwards.

## Quick start

You need an AWS account you can log in to from the terminal, with a high enough Lambda concurrency
limit (see below), a free Cloudflare account (for the Turnstile bot check), and Node 22, the AWS
CLI, the SAM CLI, cfn-lint, python3 and openssl. Setup checks for the tools and says what's
missing.

1. **Get the code and log in.**
   ```sh
   git clone https://github.com/billythemoose/shotparty.git && cd shotparty && npm ci
   aws sso login --profile <your-profile>          # or any credentials the AWS CLI can use
   export CLOUDFLARE_API_TOKEN=…                   # for prod: Account > Turnstile > Edit
   ```
2. **Run setup.** It asks a few questions, saves `shotparty.config.json`, deploys the stacks,
   creates the Turnstile widget and secrets, and creates your first event with its QR code.
   ```sh
   npm run setup
   ```
   It asks which stages to create:
   - **`dev`** to try it out. It runs on Cloudflare's test key, which always passes, so it needs
     no Cloudflare setup. Don't use it for a real event: the test key stops no bots.
   - **`prod`** for the event. It needs a real Turnstile widget. Give setup your Cloudflare account
     ID and the token above, and it creates the widget. Without the token, create a widget in the
     Cloudflare dashboard (Turnstile → Add widget) and enter its keys when setup asks.
   - **`both`**.
3. **Confirm and print.** Click the AWS alert email's confirmation link, then print the QR code
   from `qr-codes/`. Optionally subscribe the distribution to the CloudFront Free plan in the
   console (setup names the distribution; there's no API for it) and run setup again to attach
   its WAF.

Any account works once its Lambda concurrency limit is high enough: each stage reserves 205
concurrent executions, and new accounts often start at 10, which makes the deploy fail. Check it
and request an increase as described in
[docs/aws-setup.md](docs/aws-setup.md#account-requirements-both-paths). For a dedicated member
account behind a region-deny SCP, follow the optional hardened path in the same document.

Setup is safe to re-run: it resumes after a failure and changes nothing on a finished install. To
run it unattended, fill in the config yourself (`cp shotparty.config.example.json
shotparty.config.json`) and run `npm run setup -- --config shotparty.config.json`. Remove a stage
with `npm run teardown -- <stage> [--keep-data]`.

Everything after that (events, the day itself, downloads, the post-event runbook) is in
[docs/operations.md](docs/operations.md).

## Learn more

- [docs/operations.md](docs/operations.md): running events, the day itself, downloads and the
  post-event runbook.
- [docs/how-it-works/](docs/how-it-works/README.md): how each part works inside, with diagrams and
  links into the code.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the architecture summary and the cost breakdown.
- [SECURITY.md](SECURITY.md): the threat model, the protection layers and how to report a
  vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md): working on the code without an AWS account, the checks and
  the ground rules.

## License

[MIT](LICENSE).
