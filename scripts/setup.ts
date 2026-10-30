/**
 * @fileoverview One command from nothing (or from anything in between) to a working install.
 *
 *   npm run setup -- --config shotparty.config.json   unattended: no questions; change sets are
 *                                                       checked by scripts/changeset-guard.ts
 *   npm run setup                                       interactive: asks for anything missing
 *                                                       (and writes shotparty.config.json first if
 *                                                       there is none); change sets need a "y"
 * Options: --stage <dev|prod>   only this stage (default: every stage in the config)
 *          --skip-events        don't create the config's events
 *
 * Budget: the account-wide monthly budget is the <prefix>-account stack, deployed after the
 * stages, so it doesn't depend on any one stage.
 *
 * Turnstile: with cloudflare.accountId in the config and CLOUDFLARE_API_TOKEN in the environment,
 * setup creates the widget (or adds the stage's hostname to it), writes the site key into the
 * config and the secret into SSM. Otherwise the keys are entered by hand (TURNSTILE_SECRET or a
 * prompt); dev with a Cloudflare test site key always uses the test secret.
 *
 * Safe to re-run at any point: every step checks what already exists, so a failed run is resumed
 * by running it again, and a second run on a finished install changes nothing.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient, GetDistributionConfigCommand } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ACCENT_COLOR_PATTERN, eventIdKey } from '../api/src/lib/events.js';
import { assertIsError } from '../api/src/lib/result.js';
import {
  accountStackName,
  awsProfile,
  type Config,
  ConfigError,
  configPath,
  DEFAULT_CONFIG_PATH,
  isStage,
  loadConfig,
  names,
  parseConfig,
  REPO_ROOT,
  STAGES,
  stageConfig,
  type StageName,
} from './lib/config.js';
import {
  configFromAnswers,
  isTestSiteKey,
  majorVersion,
  parseCreateOutput,
  stagesFromChoice,
  TEST_SECRET,
  TEST_SITE_KEY,
  TOOLS,
  type WizardAnswers,
} from './lib/setup.js';
import {
  CloudflareError,
  ensureWidget,
  TurnstileApi,
  withSiteKey,
} from './lib/turnstile-widget.js';

const { values: opts } = parseArgs({
  options: {
    config: { type: 'string' },
    stage: { type: 'string' },
    'skip-events': { type: 'boolean', default: false },
  },
});
const unattended = Boolean(opts.config);
const exec = promisify(execFile);

function fail(message: string): never {
  console.error(`\nerror: ${message}`);
  console.error('Fix the problem and run setup again; finished steps are skipped automatically.');
  process.exit(1);
}

function heading(text: string): void {
  console.log(`\n━━ ${text}`);
}

/**
 * Runs a command with its output going straight to this terminal, so the scripts see a TTY (and
 * wait_stack can show its spinner); resolves when it exits 0, or fails setup.
 */
function runInTerminal(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('close', (code) => {
      if (code === 0) {
        done();
      } else {
        fail(`${cmd} ${args.join(' ')} exited with ${code}`);
      }
    });
  });
}

/** Runs a command with live output; resolves with its stdout (also printed) or fails setup. */
function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk;
      process.stdout.write(chunk);
    });
    child.on('close', (code) => {
      if (code === 0) {
        done(out);
      } else {
        fail(`${cmd} ${args.join(' ')} exited with ${code}`);
      }
    });
  });
}

// ---------- 0. config (written by a short interview when there is none) ----------
if (opts.config) {
  process.env.SHOTPARTY_CONFIG = resolve(opts.config);
} else if (!existsSync(process.env.SHOTPARTY_CONFIG ?? DEFAULT_CONFIG_PATH)) {
  await interview();
}
let config: Config;
try {
  config = loadConfig();
} catch (e: unknown) {
  if (e instanceof ConfigError) fail(e.message);
  throw e;
}
const stageFlag = opts.stage;
if (stageFlag !== undefined && !isStage(stageFlag)) fail('--stage must be dev or prod');
const stages = stageFlag ? [stageFlag] : STAGES.filter((s) => config.stages[s]);
for (const s of stages) {
  if (!config.stages[s]) fail(`stage "${s}" is not defined in the config`);
}

const profile = awsProfile(config);
process.env.AWS_PROFILE = profile;
const region = config.aws.region;
const scriptEnv: Record<string, string> = unattended
  ? { SHOTPARTY_ASSUME_YES: '1', SHOTPARTY_NONINTERACTIVE: '1' }
  : {};

// ---------- 1. tools ----------
heading('Checking tools');
const wantNode = majorVersion(readFileSync(resolve(REPO_ROOT, '.nvmrc'), 'utf8'));
if (majorVersion(process.version) < wantNode) {
  fail(`Node ${wantNode}+ is required (this is ${process.version}); run: nvm use`);
}
console.log(`  ok  Node ${process.version}`);
const missing: string[] = [];
for (const tool of TOOLS) {
  try {
    const { stdout, stderr } = await exec(tool.check[0], tool.check.slice(1));
    console.log(`  ok  ${tool.name}: ${(stdout || stderr).trim().split('\n')[0]}`);
  } catch {
    missing.push(`${tool.name}: ${tool.install}`);
  }
}
if (missing.length) fail(`missing tools:\n  - ${missing.join('\n  - ')}`);

// ---------- 2. who are we deploying as ----------
heading('Checking the AWS login');
let account: string;
try {
  const { stdout } = await exec('aws', [
    'sts',
    'get-caller-identity',
    '--profile',
    profile,
    '--output',
    'json',
  ]);
  const id: unknown = JSON.parse(stdout);
  if (!isCallerIdentity(id)) throw new Error(`unexpected sts output: ${stdout}`);
  account = id.Account;
  console.log(`  profile ${profile} -> account ${id.Account}\n  as ${id.Arn}`);
} catch (e: unknown) {
  assertIsError(e);
  // execFile's errors carry the command's stderr, which says why the login failed.
  const stderr = 'stderr' in e ? String(e.stderr).trim() : '';
  fail(
    `can't use AWS profile "${profile}": ${stderr || e.message}\n` +
      `  SSO: aws sso login --profile ${profile}   (or set aws.profile in the config)`,
  );
}
if (unattended && profile !== config.aws.profile) {
  fail(
    'a profile override (SHOTPARTY_PROFILE) needs interactive confirmation; run without --config',
  );
}

const ssm = new SSMClient({ region });
const cfn = new CloudFormationClient({ region });
const ddb = new DynamoDBClient({ region });
const summary: string[] = [];

for (const stage of stages) {
  const awsNames = names(config, stage);
  heading(`Stage ${stage} (account ${account}, ${region}, prefix ${config.aws.prefix})`);
  const turnstile = turnstileApi(stage);

  // ---------- 3. Turnstile widget (when the site URL is already known) ----------
  const before = await stackOutputs(awsNames.appStack);
  if (turnstile && before?.SiteUrl) await ensureTurnstile(stage, turnstile, before.SiteUrl);

  // ---------- 4. secrets ----------
  heading(`${stage}: secrets`);
  const secretArgs: string[] = [stage];
  const siteKey = stageConfig(config, stage).turnstileSiteKey;
  if (turnstile) {
    secretArgs.push('--skip-turnstile-secret');
  } else if (
    stage === 'dev' &&
    siteKey !== undefined &&
    isTestSiteKey(siteKey) &&
    (await secureParam(awsNames.param('turnstile_secret'))) !== TEST_SECRET
  ) {
    // Also replaces a real secret left over from before the stage moved to the test key.
    secretArgs.push('--turnstile-test-secret');
  }
  await runInTerminal('bash', ['scripts/bootstrap-secrets.sh', ...secretArgs], scriptEnv);

  // ---------- 5. stacks: data, then app (+ page) ----------
  const appExisted = before !== null;
  heading(`${stage}: data stack`);
  await runInTerminal('bash', ['scripts/deploy.sh', 'data', stage], scriptEnv);
  heading(`${stage}: app stack and page`);
  await runInTerminal('bash', ['scripts/deploy.sh', 'app', stage], scriptEnv);
  if (!appExisted) {
    // First install: the site URL only exists now. The widget needs it, and both stacks too
    // (upload CORS, Turnstile hostnames and, for a new widget, its site key).
    if (turnstile) {
      const url = (await stackOutputs(awsNames.appStack))?.SiteUrl ?? fail('no SiteUrl output');
      await ensureTurnstile(stage, turnstile, url);
    }
    heading(`${stage}: second pass with the new site URL`);
    await runInTerminal('bash', ['scripts/deploy.sh', 'data', stage], scriptEnv);
    await runInTerminal('bash', ['scripts/deploy.sh', 'app', stage], scriptEnv);
  }
  const outputs =
    (await stackOutputs(awsNames.appStack)) ?? fail(`${awsNames.appStack} has no outputs`);
  const siteUrl = outputs.SiteUrl ?? fail('no SiteUrl output');

  // ---------- 6. events ----------
  const events = opts['skip-events'] ? [] : config.events.filter((e) => e.stage === stage);
  if (events.length) heading(`${stage}: events`);
  const tableName = await param(awsNames.param('tableName'));
  for (const event of events) {
    const reserved = await ddb.send(
      new GetItemCommand({ TableName: tableName, Key: eventIdKey(event.eventId) }),
    );
    if (reserved.Item) {
      console.log(`  ${event.eventId}: exists, kept (change it with npm run event:update)`);
      summary.push(
        `${stage} event "${event.name}" (${event.eventId}): already existed; QR code in qr-codes/${event.eventId}-${stage}.png`,
      );
      continue;
    }
    const out = await run('npx', [
      '--no-install',
      'tsx',
      'scripts/create-event.ts',
      '--stage',
      stage,
      '--from-config',
      event.eventId,
    ]);
    const { guestUrl, pin } = parseCreateOutput(out);
    summary.push(
      `${stage} event "${event.name}": ${guestUrl ?? '(see output above)'}` +
        `\n    QR code: qr-codes/${event.eventId}-${stage}.png${pin ? `\n    PIN: ${pin}  (shown only now: write it down)` : ''}`,
    );
  }

  // ---------- 7. health ----------
  heading(`${stage}: health check`);
  await healthCheck(siteUrl);
  summary.push(`${stage} site: ${siteUrl}`);

  // ---------- 8. things only a human can do ----------
  const todo = await humanTodo(
    outputs,
    siteUrl,
    stageConfig(config, stage).turnstileSiteKey,
    turnstile !== null,
  );
  summary.push(...todo.map((t) => `${stage} TODO: ${t}`));
}

// ---------- 9. the account-wide budget (one stack for every stage) ----------
heading(`Account: ${accountStackName(config)} (the account budget)`);
const oldBudgetStages = await stagesWithOldAccountBudget();
if (oldBudgetStages.length) {
  // The budget name is taken until that app stack is redeployed with this version.
  console.log(
    `  skipped: the ${oldBudgetStages.join(' and ')} app stack still holds the old account budget. ` +
      `Run npm run setup for ${oldBudgetStages.join(' and ')} to move it here.`,
  );
  summary.push(
    `TODO: run npm run setup -- --stage ${oldBudgetStages[0]} to move the account budget to ${accountStackName(config)}`,
  );
} else {
  await runInTerminal('bash', ['scripts/deploy.sh', 'account'], scriptEnv);
  if (config.budgets.accountMonthlyUsd > 0) {
    summary.push(
      `account budget: ${config.aws.prefix}-account-monthly ($${config.budgets.accountMonthlyUsd}/month)`,
    );
  }
}

heading('Done');
for (const line of summary) {
  console.log(`  ${line}`);
}
console.log('\nRun setup again any time: it only changes what differs from the config.');

// ---------- helpers ----------

/** A decrypted SecureString, or undefined when it doesn't exist. */
async function secureParam(name: string): Promise<string | undefined> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter
      ?.Value;
  } catch {
    return undefined;
  }
}

function isCallerIdentity(value: unknown): value is { Account: string; Arn: string } {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>; // a non-null object, checked above
  return typeof identity.Account === 'string' && typeof identity.Arn === 'string';
}

async function param(name: string): Promise<string> {
  const v = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
  return v ?? fail(`missing SSM parameter ${name}`);
}

async function stackOutputs(stack: string): Promise<Record<string, string> | null> {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
    const st = res.Stacks?.[0];
    if (!st || st.StackStatus === 'REVIEW_IN_PROGRESS') return null;
    return Object.fromEntries(
      (st.Outputs ?? []).flatMap((o) =>
        o.OutputKey && o.OutputValue !== undefined ? [[o.OutputKey, o.OutputValue]] : [],
      ),
    );
  } catch (e: unknown) {
    assertIsError(e);
    if (/does not exist/.test(e.message)) return null;
    throw e;
  }
}

/**
 * Returns the stages whose app stack was deployed before Stage 33 with the account budget in it
 * (an AccountBudget=true parameter), which holds the name the account stack needs.
 */
async function stagesWithOldAccountBudget(): Promise<StageName[]> {
  const found: StageName[] = [];
  for (const stage of STAGES) {
    try {
      const res = await cfn.send(
        new DescribeStacksCommand({ StackName: names(config, stage).appStack }),
      );
      const old = res.Stacks?.[0]?.Parameters?.find((p) => p.ParameterKey === 'AccountBudget');
      if (old?.ParameterValue === 'true') found.push(stage);
    } catch (e: unknown) {
      assertIsError(e);
      if (!/does not exist/.test(e.message)) throw e;
    }
  }
  return found;
}

async function healthCheck(siteUrl: string): Promise<void> {
  // A brand-new distribution can take a few minutes to start answering.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await fetch(`${siteUrl}/api/health`, { cache: 'no-store' });
      if (res.ok) {
        console.log(
          `  ok  ${siteUrl}/api/health -> ${res.status} ${JSON.stringify(await res.json())}`,
        );
        return;
      }
      console.log(`  waiting: ${res.status} (attempt ${attempt}/30)`);
    } catch (e: unknown) {
      assertIsError(e);
      console.log(`  waiting: ${e.message} (attempt ${attempt}/30)`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10_000);
    });
  }
  fail(`${siteUrl}/api/health never answered 200`);
}

/**
 * The Cloudflare API client when setup manages this stage's widget: the config has
 * cloudflare.accountId and the stage isn't on a test key. Null means keys are handled by hand.
 */
function turnstileApi(stage: StageName): TurnstileApi | null {
  const siteKey = stageConfig(config, stage).turnstileSiteKey;
  if (!config.cloudflare || (siteKey !== undefined && isTestSiteKey(siteKey))) return null;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return new TurnstileApi(config.cloudflare.accountId, token);
  if (siteKey === undefined) {
    fail(
      `stages.${stage} has no turnstileSiteKey, so setup needs CLOUDFLARE_API_TOKEN to create the widget.\n` +
        '  Create a token at dash.cloudflare.com -> My Profile -> API Tokens with Account > Turnstile > Edit,\n' +
        '  then: export CLOUDFLARE_API_TOKEN=<token>   (or set turnstileSiteKey and TURNSTILE_SECRET by hand)',
    );
  }
  console.log(
    `  note: CLOUDFLARE_API_TOKEN isn't set, so the ${stage} Turnstile widget is managed by hand this run`,
  );
  return null;
}

/** Widget exists and allows the site's host; site key in the config, secret in SSM. */
async function ensureTurnstile(
  stage: StageName,
  api: TurnstileApi,
  siteUrl: string,
): Promise<void> {
  heading(`${stage}: Turnstile widget`);
  const host = new URL(siteUrl).host;
  const siteKey = stageConfig(config, stage).turnstileSiteKey;
  let result;
  try {
    result = await ensureWidget(api, { siteKey, name: config.aws.prefix, host });
  } catch (e: unknown) {
    if (e instanceof CloudflareError) fail(e.message);
    throw e;
  }
  const { widget, actions } = result;
  console.log(
    `  ${actions.length ? actions.join(', ') : 'ok'}: ${widget.name} (${widget.sitekey}), hostnames ${widget.domains.join(', ')}`,
  );

  if (widget.sitekey !== siteKey) {
    const path = configPath();
    writeFileSync(path, withSiteKey(readFileSync(path, 'utf8'), stage, widget.sitekey));
    config = loadConfig();
    console.log(`  wrote stages.${stage}.turnstileSiteKey to ${path}`);
  }

  const secretParam = names(config, stage).param('turnstile_secret');
  const current = await secureParam(secretParam);
  if (current === widget.secret) {
    console.log(`  ${secretParam}: matches the widget, kept`);
  } else {
    await ssm.send(
      new PutParameterCommand({
        Name: secretParam,
        Value: widget.secret,
        Type: 'SecureString',
        Overwrite: true,
        Description: 'shotparty secret (npm run setup, from the Cloudflare API)',
      }),
    );
    console.log(`  ${secretParam}: ${current === undefined ? 'set' : 'updated'} from the widget`);
  }
}

async function humanTodo(
  outputs: Record<string, string>,
  siteUrl: string,
  siteKey: string | undefined,
  turnstileManaged: boolean,
): Promise<string[]> {
  const todo: string[] = [];
  try {
    const { stdout } = await exec('aws', [
      'sns',
      'list-subscriptions-by-topic',
      '--topic-arn',
      outputs.AlertsTopicArn ?? '',
      '--profile',
      profile,
      '--region',
      region,
      '--query',
      'Subscriptions[].SubscriptionArn',
      '--output',
      'text',
    ]);
    if (/PendingConfirmation/.test(stdout)) {
      todo.push(
        `confirm the "AWS Notification - Subscription Confirmation" email, or alarms won't reach you`,
      );
    }
  } catch {
    todo.push('could not check the alert email subscription');
  }
  if (!turnstileManaged && siteKey !== undefined && !isTestSiteKey(siteKey)) {
    todo.push(
      `make sure ${new URL(siteUrl).host} is a hostname of your Turnstile widget (Cloudflare dashboard)`,
    );
  }
  if (outputs.DistributionId) {
    const cf = new CloudFrontClient({ region: 'us-east-1' });
    const dist = await cf.send(new GetDistributionConfigCommand({ Id: outputs.DistributionId }));
    if (!dist.DistributionConfig?.WebACLId) {
      todo.push(
        `optional: CloudFront console -> ${outputs.DistributionId} -> subscribe to the Free plan (WAF + rate limit), then run setup again to attach it`,
      );
    }
  }
  return todo;
}

async function interview(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (
    q: string,
    def = '',
    check?: (v: string) => string | null,
  ): Promise<string> => {
    for (;;) {
      const v = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def;
      const problem = check?.(v) ?? null;
      if (!problem) return v;
      console.log(`  ${problem}`);
    }
  };
  const required = (v: string): string | null => (v ? null : 'required');
  const yes = async (q: string, def: boolean): Promise<boolean> =>
    /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

  console.log(
    `No config yet: a few questions, then everything is saved to ${DEFAULT_CONFIG_PATH}\n` +
      '(edit that file later and run setup again to apply changes).\n',
  );
  const answers: WizardAnswers = {
    profile: await ask('AWS CLI profile to deploy with', process.env.AWS_PROFILE ?? 'default'),
    region: await ask('AWS region', 'us-east-1'),
    prefix: await ask('Name prefix for the AWS resources', 'shotparty', (v) =>
      /^[a-z][a-z0-9-]{1,20}[a-z0-9]$/.test(v)
        ? null
        : 'lowercase letters, digits and dashes, 3-22 chars',
    ),
    email: await ask('Email for alarms and budget alerts', '', (v) =>
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "that doesn't look like an email address",
    ),
    stages:
      stagesFromChoice(
        await ask(
          'Stages to create: prod (for the event), dev (to try it out) or both',
          'prod',
          (v) => (stagesFromChoice(v) ? null : 'prod, dev or both'),
        ),
      ) ?? [],
    siteKeys: {},
  };
  // Only prod gets a real widget; dev runs on the test key unless given one.
  const accountId = answers.stages.includes('prod')
    ? await ask(
        'Cloudflare account ID, so setup creates the Turnstile widget (blank = enter keys yourself)',
        '',
        (v) =>
          !v || /^[0-9a-f]{32}$/.test(v) ? null : '32 hex characters, from the dashboard URL',
      )
    : '';
  if (accountId) answers.cloudflareAccountId = accountId;
  for (const st of answers.stages) {
    if (accountId && st === 'prod') continue; // setup creates it
    answers.siteKeys[st] = await ask(
      st === 'dev'
        ? 'Cloudflare Turnstile site key for dev (Cloudflare dashboard -> Turnstile; blank = test key)'
        : 'Cloudflare Turnstile site key for prod (Cloudflare dashboard -> Turnstile; required)',
      st === 'dev' ? TEST_SITE_KEY : '',
      (v) => (v || st === 'dev' ? null : 'prod needs a real site key'),
    );
  }
  if (accountId && !process.env.CLOUDFLARE_API_TOKEN) {
    console.log(
      '\nSetup needs CLOUDFLARE_API_TOKEN to create the widget: dash.cloudflare.com -> My Profile ->\n' +
        'API Tokens -> Create Token, with the permission Account > Turnstile > Edit. Stop here\n' +
        '(Ctrl-C), run "export CLOUDFLARE_API_TOKEN=<token>", and run npm run setup again: these\n' +
        'answers are saved first.\n',
    );
  }
  if (await yes('Create your first event now?', true)) {
    const name = await ask('Event name (shown on the page)', '', required);
    answers.event = {
      name,
      openFrom: (await ask('Uploads open (ISO date with offset, blank = now)', '')) || undefined,
      openUntil: (await ask('Uploads close (blank = 60 days after opening)', '')) || undefined,
      pin: await yes('Require a PIN printed next to the QR code?', false),
      headline: (await ask('Headline (blank = "Share your photos")', '')) || undefined,
      welcome: (await ask('Welcome line (blank = default)', '')) || undefined,
      thanks: (await ask('Thank-you message (blank = "Thank you!")', '')) || undefined,
      accentColor:
        (await ask('Accent color #rrggbb (blank = default blue)', '', (v) =>
          !v || ACCENT_COLOR_PATTERN.test(v) ? null : 'use #rrggbb, e.g. #1a5fb4',
        )) || undefined,
    };
  }
  rl.close();

  const raw = configFromAnswers(answers);
  try {
    parseConfig(raw);
  } catch (e: unknown) {
    if (e instanceof ConfigError) fail(e.message);
    throw e;
  }
  writeFileSync(DEFAULT_CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\nSaved ${DEFAULT_CONFIG_PATH}. Continuing with setup.`);
}
