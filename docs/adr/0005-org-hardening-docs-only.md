# 0005: Org hardening is a documented option, not a script

- **Status:** Accepted (2026-10-14, Stage 21)
- **Deciders:** organizer, Claude

## Context

The original install ran in a dedicated AWS member account: an Organization, a `Workloads` OU, a
region-deny SCP, root access centralized and IAM Identity Center for the CLI. That isolates the
event's blast radius from everything else the organizer runs, and it's how the project was built
(Stage 1).

For self-hosters, Stage 21 set out to make it a config flag (`org.enabled`) and an idempotent
`org-setup` script that created the OU, the account, the SCP and the CLI profile. The script was
built and unit-tested, then removed before it was committed.

## Decision

Deploy into **whatever account the user is logged in to** by default. The hardened layout stays
a manual, step-by-step checklist with CLI equivalents in
[aws-setup.md](../aws-setup.md#hardened-optional), and the optional SCP lives in `infra/org/`.

Why not the script:

- Few self-hosters need it. An event uploader is almost always run in one account, and creating an
  Organization or a member account (which takes 90 days to close) is a step a careful person wants
  to take by hand.
- It would have been the riskiest code in the repository: administrator rights over a whole
  Organization, with no way to test it against AWS in CI.
- Verifying it meant a new role in the management account, just to confirm a no-op.

## Consequences

- The default install is a single `npm run setup`. The budget comes from the stack
  (`accountBudget`), not from an account-setup step.
- People who want isolation follow the checklist; nothing in the deploy path changes.
- The isolation story is told in docs, here and in [SECURITY.md](../../SECURITY.md), rather than
  in code.

## Evidence

- Stage 1: the hardened path was set up by hand and verified (`eu-west-1` denied by the SCP, no
  long-lived keys).
- Stage 21: the script's first dry run correctly refused a member-account profile, and was then
  removed.
