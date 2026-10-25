# Architecture decision records

Short records of the decisions that shaped shotparty: the context, what was decided, and what it
cost. "Stage N" in a record names the step of the original build where the decision was made or
proven.

| #                                         | Decision                                                      | Status   |
| ----------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-two-stack-split.md)           | Split each stage into a protected data stack and an app stack | Accepted |
| [0002](0002-cloudfront-free-plan-waf.md)  | Use the CloudFront Free flat-rate plan for WAF                | Accepted |
| [0003](0003-no-dynamodb-transactions.md)  | Reserve quotas with single-item updates, not transactions     | Accepted |
| [0004](0004-magic-byte-validation.md)     | Validate uploads by their magic bytes after they land         | Accepted |
| [0005](0005-org-hardening-docs-only.md)   | Org hardening is a documented option, not a script            | Accepted |

New records copy the shape of an existing one: Status, Context, Decision, Consequences, Evidence.
