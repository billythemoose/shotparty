/**
 * @fileoverview Creates an event and prints the guest URL (for the QR code) and PIN.
 *
 *   npm run event:create -- --stage dev --name "Summer Party" \
 *     --open-from 2026-10-10T18:00:00-07:00 --open-until 2026-11-30T23:59:59-08:00 --generate-pin
 *   npm run event:create -- --stage prod --from-config summer-party-2026   (values from the config's events)
 *
 * Options: --from-config <eventId>  take every value below from the config's events[] entry;
 *                                  flags given on the command line override it
 *          --pin <pin> | --generate-pin (default: no PIN)
 *          --headline --welcome --thanks --accent-color <#rrggbb>
 *                                guest-page text and color (default: neutral; change later
 *                                with event:update)
 *          --event-id <folder>   S3 folder name (default: <name-slug>-<year>); must be unused
 *          --base-url <https://...> (default: the stage's CloudFront SiteUrl)
 *          --qr-dir <dir>        where the QR code is written (default: qr-codes/, git-ignored)
 *          --session-files <n> --session-gb <n> --ip-files-per-hour <n> --event-files <n>
 *          --event-gb <n>        override upload quotas (defaults: the config's uploads section,
 *                                then api/src/lib/quota.ts)
 *          --profile <aws profile>
 */
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  EVENT_ID_PATTERN,
  type EventRecord,
  eventIdFromName,
  hashPin,
  newPin,
  newToken,
  normalizeDisplay,
  slugify,
  yearOf,
} from '../api/src/lib/events.js';
import { DEFAULT_LIMITS, type QuotaLimits } from '../api/src/lib/quota.js';
import { assertIsError } from '../api/src/lib/result.js';
import { awsProfile, configEvent, loadConfigOrExit, names } from './lib/config.js';
import { createEventTransaction, explainCreateFailure } from './lib/create-event.js';
import { parseLimitFlags } from './lib/event-admin.js';
import { writeQrFiles } from './lib/qr.js';

const { values: cli } = parseArgs({
  options: {
    stage: { type: 'string' },
    'from-config': { type: 'string' },
    headline: { type: 'string' },
    welcome: { type: 'string' },
    thanks: { type: 'string' },
    'accent-color': { type: 'string' },
    name: { type: 'string' },
    'open-from': { type: 'string' },
    'open-until': { type: 'string' },
    pin: { type: 'string' },
    'generate-pin': { type: 'boolean' },
    'event-id': { type: 'string' },
    'base-url': { type: 'string' },
    'qr-dir': { type: 'string', default: 'qr-codes' },
    'session-files': { type: 'string' },
    'session-gb': { type: 'string' },
    'ip-files-per-hour': { type: 'string' },
    'event-files': { type: 'string' },
    'event-gb': { type: 'string' },
    profile: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const config = loadConfigOrExit();
// A config event supplies defaults; anything given on the command line wins.
const opts = { ...fromConfig(cli['from-config']), ...definedOnly(cli) };

const stage = opts.stage;
if (stage !== 'dev' && stage !== 'prod') fail('--stage must be dev or prod');
const name = opts.name?.trim() || fail('--name is required');
if (opts.pin && opts['generate-pin']) fail('use --pin or --generate-pin, not both');
const { display, problems } = normalizeDisplay({
  headline: opts.headline,
  welcome: opts.welcome,
  thanks: opts.thanks,
  accentColor: opts['accent-color'],
});
if (problems.length) fail(problems.join('; '));

const openFrom = new Date(opts['open-from'] ?? Date.now());
const openUntil = new Date(opts['open-until'] ?? openFrom.getTime() + 60 * 86_400_000);
if (Number.isNaN(openFrom.getTime()) || Number.isNaN(openUntil.getTime())) {
  fail('--open-from/--open-until must be ISO dates, e.g. 2026-10-10T18:00:00-07:00');
}
if (openUntil <= openFrom) fail('--open-until must be after --open-from');

// The S3 folder name: an explicit --event-id goes through the same slug rules as generated ones.
const eventId = opts['event-id']
  ? slugify(opts['event-id'], 64)
  : eventIdFromName(name, yearOf(opts['open-from']));
if (!EVENT_ID_PATTERN.test(eventId)) {
  fail(`--event-id "${opts['event-id']}" has no usable characters`);
}
if (opts['event-id'] && eventId !== opts['event-id']) {
  console.warn(`note: --event-id normalized to "${eventId}"`);
}

// Quota overrides: counts are whole numbers, sizes are given in GiB.
const parsedLimits = parseLimitFlags(opts);
if (!parsedLimits.ok) fail(`--${parsedLimits.error.flag} must be a positive number`);
const limits = parsedLimits.value;

process.env.AWS_PROFILE = awsProfile(config, opts.profile);
const region = config.aws.region;
const awsNames = names(config, stage);
const ssm = new SSMClient({ region });
const ddb = new DynamoDBClient({ region });
const cfn = new CloudFormationClient({ region });

const tableName = (await ssm.send(new GetParameterCommand({ Name: awsNames.param('tableName') })))
  .Parameter?.Value;
if (!tableName) fail(`no ${awsNames.param('tableName')} parameter (is the data stack deployed?)`);

let baseUrl = opts['base-url'];
if (!baseUrl) {
  const stack = await cfn.send(new DescribeStacksCommand({ StackName: awsNames.appStack }));
  baseUrl = stack.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'SiteUrl')?.OutputValue;
  if (!baseUrl) fail('could not find SiteUrl; pass --base-url');
}

const pin = opts['generate-pin'] ? newPin() : opts.pin;
const event: EventRecord = {
  token: newToken(),
  eventId,
  name,
  openFrom: openFrom.toISOString(),
  openUntil: openUntil.toISOString(),
  ...(pin ? { pinHash: hashPin(pin) } : {}),
  ...(Object.keys(limits).length ? { limits } : {}),
  ...(Object.keys(display).length ? { display } : {}),
};

try {
  await ddb.send(
    new TransactWriteItemsCommand(createEventTransaction(tableName, event, new Date())),
  );
} catch (e: unknown) {
  assertIsError(e);
  fail(explainCreateFailure(e, event.eventId) ?? e.message);
}

const url = `${baseUrl.replace(/\/$/, '')}/e/${event.token}`;
const qrFiles = await writeQrFiles(url, opts['qr-dir'] ?? 'qr-codes', `${event.eventId}-${stage}`);
console.log(`
Event created (${stage})
  Name:      ${event.name}
  Folder:    uploads/${event.eventId}/  ->  accepted/${event.eventId}/
  Window:    ${event.openFrom}  ->  ${event.openUntil}  (UTC)
  PIN:       ${pin ?? '(none)'}
  Limits:    ${describeLimits({ ...installLimits(), ...limits })}
  Page:      ${describeDisplay()}
  Guest URL: ${url}
  QR code:   ${qrFiles.join('\n             ')}

Keep the URL and QR files private until printing: anyone with them${pin ? ' (and the PIN)' : ''} can upload.${
  pin ? '\nPrint the PIN as text next to the QR code, never inside it.' : ''
}
`);

function describeDisplay(): string {
  const set = Object.entries(display).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return set.length ? set.join(', ') : 'neutral defaults (change with event:update)';
}

function definedOnly<T extends object>(o: T): Partial<T> {
  // Only drops keys, so the result is a Partial<T>; Object.fromEntries can't express that.
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The config's events[] entry as command-line options. */
function fromConfig(eventId: string | undefined): Partial<typeof cli> {
  if (!eventId) return {};
  let e;
  try {
    e = configEvent(config, eventId);
  } catch (caught: unknown) {
    assertIsError(caught);
    fail(caught.message);
  }
  return definedOnly({
    name: e.name,
    'event-id': e.eventId,
    'open-from': e.openFrom,
    'open-until': e.openUntil,
    'generate-pin': e.pin === 'generate' ? true : undefined,
    headline: e.headline,
    welcome: e.welcome,
    thanks: e.thanks,
    'accent-color': e.accentColor,
  });
}

/** The limits events start from: the built-in ones with the config's session defaults. */
function installLimits(): QuotaLimits {
  const { sessionFiles, sessionBytes } = config.uploads;
  return { ...DEFAULT_LIMITS, sessionFiles, sessionBytes };
}

function describeLimits(limits: QuotaLimits): string {
  const gb = (bytes: number): string => `${Number((bytes / 1024 ** 3).toFixed(2))} GiB`;
  const { sessionFiles, sessionBytes, ipFilesPerHour, eventFiles, eventBytes } = limits;
  return (
    `${sessionFiles} files/${gb(sessionBytes)} per guest session, ` +
    `${ipFilesPerHour} files/hour per network, ${eventFiles} files/${gb(eventBytes)} per event`
  );
}
