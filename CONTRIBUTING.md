# Contributing

Thanks for helping. Bug reports, fixes and small features are all welcome. For anything bigger,
open an issue first so we can agree on the approach. For security issues, see
[SECURITY.md](SECURITY.md) instead.

## Getting set up

You need Node 22 (`.nvmrc`). That's enough for everything except the infrastructure checks, which
also need cfn-lint, the SAM CLI and shellcheck. The devcontainer (`.devcontainer/`, for VS Code or
Codespaces) has all of them, plus the AWS CLI. It mounts `~/.aws` from your machine, so create that
folder first if you've never used the AWS CLI.

```sh
npm ci
npx playwright install chromium     # once, for the browser tests
```

You don't need an AWS account to work on the code. To look at the guest page with a fake API:

```sh
npm run mock-api                                  # terminal 1
API_ORIGIN=http://localhost:8787 npm start        # terminal 2, then open a link it printed
```

| Path       | Purpose                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `api/`     | Lambda handlers (`src/handlers`) and pure logic (`src/lib`), with tests |
| `web/`     | The guest page (Vite + TypeScript, no framework), unit and `e2e/` tests |
| `infra/`   | SAM templates: `data/`, `app/`, and the optional `org/` SCP             |
| `scripts/` | Setup, deploy, events, gallery, download, load and abuse tests          |
| `docs/`    | How it works, architecture, operations, AWS setup                       |

## Checks

CI runs all of these on every pull request. Run them before you push:

```sh
npm run lint            # eslint + prettier (npm run format fixes formatting)
npm run typecheck
npm test                # unit tests (vitest)
npm run test:e2e        # browser tests of the guest page (Playwright, API mocked)
npm run lint:infra      # cfn-lint + bash -n
npm run lint:shell      # shellcheck
npm run lint:identifiers  # no account IDs, CloudFront domains, real keys or emails
npm run lint:docs       # every relative link and file:line reference in the Markdown resolves
```

If your change moves test coverage, refresh the README badge with
`npm run test:coverage && npm run coverage:badge`.
If it changes the guest page's look, redraw the README screenshots with `npm run screenshots`.

If it changes how a subsystem works, update its page in [docs/how-it-works/](docs/how-it-works/README.md).
Diagrams there are Mermaid in the Markdown, plus the D2 architecture overview: edit
`docs/diagrams/*.d2` and run `npm run diagrams` (needs [d2](https://d2lang.com)).

## Ground rules

- **Never put the media bucket or the table in the app stack, and never make a change that replaces
  them.** They hold guests' photos. The data stack refuses replacement, and unattended deploys check
  every change set (`scripts/changeset-guard.ts`), but please don't rely on that.
- **Don't change the CloudFront distribution in a way that replaces it.** Its domain is printed on
  every QR card.
- **Keep it near-free.** If a change adds a recurring AWS or Cloudflare cost, say so in the pull
  request.
- **No secrets, account IDs or real hostnames in the repository.** Secrets belong in SSM Parameter
  Store. Your own settings go in `shotparty.config.json`, which is git-ignored. Use AWS's
  documentation values in examples and tests (`111122223333`, `d111111abcdef8.cloudfront.net`,
  `@example.com`); `npm run lint:identifiers` refuses anything else that looks like a real one. To
  block your own literal values too, list them in a git-ignored `.identifiers.local`.
- **Test with the change.** Pure logic lives in `api/src/lib`, `web/src` and `scripts/lib` and has
  unit tests. Guest-page behavior has Playwright tests in `web/e2e`.
- Match the surrounding code: TypeScript strict mode, small modules and comments that explain why.
  The code follows the Google TypeScript Style Guide; `npm run lint` checks most of it. Two rules it
  can't check: expected failures (a wrong PIN, a full quota, a network error) are returned as a
  `Result` with `{ kind }` error variants (`api/src/lib/result.ts`) and handled with an exhaustive
  `switch`, while exceptions are kept for bugs; and data from outside (API responses, JSON files,
  `localStorage`) is checked with a type guard, never cast with `as`.

## Pull requests

Keep each pull request to one change, describe what you tested (and on which stage, if you
deployed it), and update the README or `docs/` when behavior changes. By contributing, you agree
your work is released under the [MIT License](LICENSE).
