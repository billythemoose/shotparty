# 0001: Split each stage into a protected data stack and an app stack

- **Status:** Accepted (2026-09-24, Stage 2; proven in Stage 14)
- **Deciders:** organizer, Claude

## Context

The guests' photos are the only thing in the system that can't be recreated. Everything else
(Lambdas, the API, CloudFront, alarms) changes often while the project is being built, and
CloudFormation replaces a resource when certain properties change. One template holding both the
code and the media bucket means one careless edit, or one `sam delete`, can take the photos with it.

## Decision

Each stage (`dev`, `prod`) is two CloudFormation stacks:

- **`<prefix>-<stage>-data`**: the media S3 bucket and the DynamoDB table, nothing else.
  - `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on both.
  - Generated names (no `BucketName` / `TableName`), so no rename can force a replacement.
  - Termination protection, and a **stack policy** that denies `Update:Replace` and
    `Update:Delete` on both resources.
  - S3 versioning; DynamoDB point-in-time recovery and deletion protection.
- **`<prefix>-<stage>-app`**: everything else. Safe to redeploy, break or delete.

The data stack publishes its names and ARNs to **SSM parameters**, which the app stack reads as
`AWS::SSM::Parameter::Value<String>` parameters. CloudFormation `Export` / `ImportValue` is avoided
because an export locks both stacks against edits.

Unattended deploys also run every change set through `scripts/changeset-guard.ts`, which refuses
any replacement or deletion in the data stack.

## Consequences

- The app stack can be torn down and rebuilt with the photos untouched (`scripts/delete-app.sh`).
- Two stacks to deploy, and a stage's first deploy runs `data`, `app`, then both again, so the
  bucket's CORS picks up the new site URL.
- Changing the table's key schema is impossible in place. That's intended: it would mean a
  migration, not an edit.
- SSM parameters are free; Secrets Manager or exports would have cost money or flexibility.

## Evidence

- Stage 2: the data stack was deployed, torn down and rebuilt from scratch.
- Stage 14 (redeploy-safety drill): a change set that would replace the table was **executed**,
  and the stack policy refused it; the data was unchanged.
- Stage 19: unattended runs (`npm run setup -- --config …`) pass every change set through the guard before executing it.
