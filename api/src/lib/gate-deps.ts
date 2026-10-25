/**
 * @fileoverview AWS-backed GateDeps, shared by the presign and event handlers. Both lookups are
 * cached per Lambda container for 30 s, so the kill switch takes effect within ~30 s of being
 * flipped.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { eventFromItem, eventKey, type EventRecord } from './events.js';
import { type GateDeps, ttlCache } from './gate.js';
import { requireEnv } from './http.js';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
const CACHE_MS = 30_000;

const enabledCache = ttlCache<boolean>(CACHE_MS);
const eventCache = ttlCache<EventRecord | null>(CACHE_MS);

/** The real gate dependencies: SSM kill switch, DynamoDB events, the system clock. */
export const gateDeps: GateDeps = {
  uploadsEnabled: () =>
    enabledCache('enabled', async () => {
      const res = await ssm.send(
        new GetParameterCommand({ Name: requireEnv('UPLOADS_ENABLED_PARAM') }),
      );
      // Fail closed: anything other than "true" disables uploads.
      return res.Parameter?.Value?.trim().toLowerCase() === 'true';
    }),
  getEvent: (token) =>
    eventCache(token, async () => {
      const res = await ddb.send(
        new GetItemCommand({ TableName: requireEnv('TABLE_NAME'), Key: eventKey(token) }),
      );
      return res.Item ? eventFromItem(token, res.Item) : null;
    }),
  now: () => new Date(),
};
