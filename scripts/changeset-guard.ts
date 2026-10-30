/**
 * @fileoverview Used by scripts/deploy.sh before every change set runs: exits 1 (and explains) when
 * the change set would replace or delete protected resources (see scripts/lib/changeset-guard.ts).
 * Unattended deploys stop there; with --warn (interactive deploys) the explanation is a warning
 * and deploy.sh asks whether to deploy anyway.
 *
 *   tsx scripts/changeset-guard.ts <data|app|account> <change-set-arn> [--warn]
 */
import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  type DescribeChangeSetCommandOutput,
} from '@aws-sdk/client-cloudformation';
import { awsProfile, loadConfigOrExit } from './lib/config.js';
import { type ResourceChange, riskyChanges } from './lib/changeset-guard.js';

const [kind, arn, flag] = process.argv.slice(2);
const warnOnly = flag === '--warn';
if (
  (kind !== 'data' && kind !== 'app' && kind !== 'account') ||
  !arn ||
  (flag !== undefined && !warnOnly)
) {
  console.error('usage: changeset-guard.ts <data|app|account> <change-set-arn> [--warn]');
  process.exit(2);
}

const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config);
const cfn = new CloudFormationClient({ region: config.aws.region });

const changes: ResourceChange[] = [];
let next: string | undefined;
do {
  const page: DescribeChangeSetCommandOutput = await cfn.send(
    new DescribeChangeSetCommand({ ChangeSetName: arn, NextToken: next }),
  );
  for (const c of page.Changes ?? []) {
    if (c.ResourceChange) changes.push(c.ResourceChange);
  }
  next = page.NextToken;
} while (next);

const reasons = riskyChanges(kind, changes);
if (reasons.length) {
  console.error(
    warnOnly
      ? `WARNING: this ${kind} change set changes protected resources:`
      : `refusing to execute this ${kind} change set unattended:`,
  );
  for (const r of reasons) {
    console.error(`  - ${r}`);
  }
  console.error(
    warnOnly
      ? 'Deploy only if this is really intended.'
      : 'Review it and deploy interactively (scripts/deploy.sh) if it is really intended.',
  );
  process.exit(1);
}
console.log(
  `==> Change set checked: ${changes.length} change(s), nothing protected is replaced or deleted`,
);
