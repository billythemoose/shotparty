/** @fileoverview Stores upload sessions in DynamoDB and reads them back (cached 30 s). */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { ttlCache } from './gate.js';
import { requireEnv } from './http.js';
import { type SessionRecord, sessionFromItem, sessionKey, sessionToItem } from './session.js';

const ddb = new DynamoDBClient({});
const cache = ttlCache<SessionRecord | null>(30_000);

/** Stores a new session; the condition refuses to overwrite an existing one. */
export async function saveSession(record: SessionRecord): Promise<void> {
  await ddb.send(
    new PutItemCommand({
      TableName: requireEnv('TABLE_NAME'),
      Item: sessionToItem(record),
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

/** Returns the stored session, or null. Deleting the record revokes it (within the 30 s cache). */
export function loadSession(id: string): Promise<SessionRecord | null> {
  return cache(id, async () => {
    const res = await ddb.send(
      new GetItemCommand({ TableName: requireEnv('TABLE_NAME'), Key: sessionKey(id) }),
    );
    return res.Item ? sessionFromItem(id, res.Item) : null;
  });
}
