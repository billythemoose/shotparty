/**
 * @fileoverview Closes an event's upload window right now (sets openUntil = now). Guests then see
 * "Uploads for this event have closed" within ~30 s (Lambda cache). Files already uploaded are
 * untouched. Reopen by creating a new event, or extend with --until.
 *
 *   npm run event:close -- --stage prod --event-id test-event-2026
 *   npm run event:close -- --stage prod --event-id <folder> --until 2026-11-30T23:59:59-08:00
 */
import { parseArgs } from 'node:util';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { EVENT_ID_PATTERN, eventKey } from '../api/src/lib/events.js';
import { awsProfile, loadConfigOrExit, names } from './lib/config.js';
import { findEventByFolder } from './lib/event-admin.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    'event-id': { type: 'string' },
    until: { type: 'string' },
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
const until = opts.until ? new Date(opts.until) : new Date();
if (Number.isNaN(until.getTime())) {
  fail('--until must be an ISO date, e.g. 2026-11-30T23:59:59-08:00');
}

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
if (until.toISOString() <= event.openFrom) {
  fail(`--until must be after the event opens (${event.openFrom})`);
}

await ddb.send(
  new UpdateItemCommand({
    TableName: tableName,
    Key: eventKey(event.token),
    UpdateExpression: 'SET openUntil = :until',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':until': { S: until.toISOString() } },
  }),
);
console.log(
  `${event.name} (${eventId}, ${stage}): upload window end ${event.openUntil} -> ${until.toISOString()}` +
    `\nGuests see the change within ~30 s.`,
);
