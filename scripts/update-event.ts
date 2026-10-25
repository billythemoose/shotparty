/**
 * @fileoverview Changes an existing event's name, guest-page text/color and upload quotas, without
 * a new token or QR code. Guests see the change within ~30 s (Lambda cache). For the upload
 * window, use event:close.
 *
 *   npm run event:update -- --stage prod --event-id summer-party-2026 \
 *     --headline "Say cheese" --welcome "Add your photos from tonight." --accent-color "#1a5fb4"
 *   npm run event:update -- --stage prod --event-id <folder> --clear thanks,accentColor  (back to defaults)
 *   npm run event:update -- --stage prod --event-id <folder> --session-gb 50 --session-files 2000
 *
 * Options: --name --headline --welcome --thanks --accent-color <#rrggbb>
 *          --clear <field,...|all>   remove fields so the page uses its neutral default
 *          --session-files <n> --session-gb <n> --ip-files-per-hour <n> --event-files <n>
 *          --event-gb <n>            raise or lower this event's upload quotas (applies to new
 *                                    presigns; uploads already counted stay counted)
 *          --profile <aws profile>
 */
import { parseArgs } from 'node:util';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  DISPLAY_FIELDS,
  EVENT_ID_PATTERN,
  eventKey,
  normalizeDisplay,
} from '../api/src/lib/events.js';
import { awsProfile, loadConfigOrExit, names } from './lib/config.js';
import {
  buildDisplayUpdate,
  findEventByFolder,
  LIMIT_FLAG_NAMES,
  parseClearList,
  parseLimitFlags,
} from './lib/event-admin.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    'event-id': { type: 'string' },
    name: { type: 'string' },
    headline: { type: 'string' },
    welcome: { type: 'string' },
    thanks: { type: 'string' },
    'accent-color': { type: 'string' },
    clear: { type: 'string' },
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

const stage = opts.stage;
if (stage !== 'dev' && stage !== 'prod') fail('--stage must be dev or prod');
const eventId = opts['event-id'] ?? fail('--event-id <folder> is required');
if (!EVENT_ID_PATTERN.test(eventId)) fail(`--event-id "${eventId}" is not a valid event folder`);

const { display, problems } = normalizeDisplay({
  headline: opts.headline,
  welcome: opts.welcome,
  thanks: opts.thanks,
  accentColor: opts['accent-color'],
});
if (problems.length) fail(problems.join('; '));
const clear = parseClearList(opts.clear);
if (!clear.ok) {
  fail(`--clear: unknown field "${clear.error.field}" (use ${DISPLAY_FIELDS.join(', ')} or all)`);
}
const limits = parseLimitFlags(opts);
if (!limits.ok) fail(`--${limits.error.flag} must be a positive number`);
const update = buildDisplayUpdate({
  name: opts.name?.trim() || undefined,
  set: display,
  clear: clear.value,
  limits: limits.value,
});
if (!update.ok) fail(`can't both set and clear ${update.error.field}`);
if (!update.value) {
  fail(
    'nothing to change: pass --name, --headline, --welcome, --thanks, --accent-color, --clear ' +
      `or a quota flag (${LIMIT_FLAG_NAMES.map((f) => `--${f}`).join(', ')})`,
  );
}
const expression = update.value;

const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config, opts.profile);
const region = config.aws.region;
const awsNames = names(config, stage);
const ssm = new SSMClient({ region });
const ddb = new DynamoDBClient({ region });
const tableName =
  (await ssm.send(new GetParameterCommand({ Name: awsNames.param('tableName') }))).Parameter
    ?.Value ?? fail('no table parameter');

const [event, ...others] = await findEventByFolder(ddb, tableName, eventId);
if (!event || others.length > 0) {
  fail(
    `expected exactly one event "${eventId}" in ${stage}, found ${others.length + (event ? 1 : 0)}`,
  );
}

await ddb.send(
  new UpdateItemCommand({
    TableName: tableName,
    Key: eventKey(event.token),
    ConditionExpression: 'attribute_exists(pk)',
    ...expression,
  }),
);
console.log(
  `${opts.name?.trim() || event.name} (${eventId}, ${stage}) updated: ${expression.UpdateExpression}`,
);
console.log('Guests see the change within ~30 s. The guest URL and QR code are unchanged.');
