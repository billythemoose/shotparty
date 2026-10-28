/**
 * @fileoverview Bridge from shotparty.config.json to the bash scripts: prints shell assignments
 * to `eval`. Used by scripts/lib.sh (load_config, load_deploy_params); not meant to be run by hand.
 *
 *   tsx scripts/config-env.ts                          CONFIG_PROFILE, PROFILE, REGION, PREFIX, ALERT_EMAIL
 *   tsx scripts/config-env.ts --deploy app --stage dev  + STACK_NAME, PARAM_OVERRIDES=(…), TAGS=(…)
 *   tsx scripts/config-env.ts --deploy account          the same for the <prefix>-account stack
 */
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, GetDistributionConfigCommand } from '@aws-sdk/client-cloudfront';
import { assertIsError } from '../api/src/lib/result.js';
import { awsProfile, ConfigError, isStage, loadConfig, names } from './lib/config.js';
import {
  accountDeployParams,
  type DeployParams,
  type Discovered,
  deployParams,
  shellQuote,
} from './lib/deploy-params.js';

const { values: opts } = parseArgs({
  options: { deploy: { type: 'string' }, stage: { type: 'string' } },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (e: unknown) {
  if (e instanceof ConfigError) fail(e.message);
  throw e;
}

const profile = awsProfile(config);
const lines = [
  `CONFIG_PROFILE=${shellQuote(config.aws.profile)}`,
  `PROFILE=${shellQuote(profile)}`,
  `REGION=${shellQuote(config.aws.region)}`,
  `PREFIX=${shellQuote(config.aws.prefix)}`,
  `ALERT_EMAIL=${shellQuote(config.alerts.email ?? '')}`,
];

if (opts.deploy === 'account') {
  pushDeployParams(accountDeployParams(config));
} else if (opts.deploy) {
  const kind = opts.deploy;
  if (kind !== 'data' && kind !== 'app') fail('--deploy must be data, app or account');
  if (!isStage(opts.stage)) fail('--stage must be dev or prod');
  const stage = opts.stage;

  process.env.AWS_PROFILE = profile;
  const discovered = await discover(names(config, stage).appStack, config.aws.region).catch(
    (e: unknown) => {
      assertIsError(e);
      return fail(
        e.name === 'CredentialsProviderError'
          ? `AWS login for profile "${profile}" failed (${e.message.split('.')[0]}). Run: aws sso login --profile ${profile}`
          : `could not read the ${stage} stacks: ${e.message}`,
      );
    },
  );
  try {
    pushDeployParams(deployParams(config, stage, kind, discovered));
  } catch (e: unknown) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
}

console.log(lines.join('\n'));

/** Prints the warnings and adds STACK_NAME, PARAM_OVERRIDES and TAGS to the output. */
function pushDeployParams(params: DeployParams): void {
  for (const w of params.warnings) {
    console.error(`warning: ${w}`);
  }
  const quoteAll = (values: string[]): string => values.map((v) => shellQuote(v)).join(' ');
  lines.push(
    `STACK_NAME=${shellQuote(params.stackName)}`,
    `PARAM_OVERRIDES=(${quoteAll(params.parameterOverrides)})`,
    `TAGS=(${quoteAll(params.tags)})`,
  );
}

/** Reads the app stack's site URL and the web ACL attached to its distribution, if they exist. */
async function discover(appStack: string, region: string): Promise<Discovered> {
  const cfn = new CloudFormationClient({ region });
  let outputs: Record<string, string>;
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: appStack }));
    outputs = Object.fromEntries(
      (res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
    );
  } catch (e: unknown) {
    // Not deployed yet is expected on a first deploy; anything else (expired login…) is fatal.
    assertIsError(e);
    if (!/does not exist/.test(e.message)) throw e;
    return {};
  }
  const discovered: Discovered = { siteUrl: outputs.SiteUrl || undefined };
  if (outputs.DistributionId) {
    const cf = new CloudFrontClient({ region: 'us-east-1' });
    const res = await cf.send(new GetDistributionConfigCommand({ Id: outputs.DistributionId }));
    discovered.webAclArn = res.DistributionConfig?.WebACLId || undefined;
  }
  return discovered;
}
