/**
 * @fileoverview TEST HELPER core: creates an upload session exactly as POST /api/session would
 * after Turnstile (+ PIN), signed with the stage's session key and stored in DynamoDB. Needs AWS
 * admin credentials, so it grants nothing a guest could use. Prod requires an explicit allowProd
 * (rehearsals only).
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  eventFromItem,
  eventKey,
  type EventRecord,
  TOKEN_PATTERN,
} from '../../api/src/lib/events.js';
import { issueSession, sessionToItem } from '../../api/src/lib/session.js';
import { type Config, names } from './config.js';

/** Mints upload sessions for one event. */
export interface Minter {
  event: EventRecord;
  mint(): Promise<string>;
}

/** Returns a minter for the event with this token (reads the session key from SSM). */
export async function createMinter(opts: {
  config: Config;
  stage: 'dev' | 'prod';
  eventToken: string;
  allowProd?: boolean;
}): Promise<Minter> {
  if (opts.stage === 'prod' && !opts.allowProd) {
    throw new Error(
      'minting prod sessions bypasses Turnstile: pass --allow-prod (rehearsals only)',
    );
  }
  if (!TOKEN_PATTERN.test(opts.eventToken)) throw new Error('invalid event token');

  const region = opts.config.aws.region;
  const n = names(opts.config, opts.stage);
  const ssm = new SSMClient({ region });
  const ddb = new DynamoDBClient({ region });
  const param = async (name: string): Promise<string> => {
    const v = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })))
      .Parameter?.Value;
    if (!v) throw new Error(`missing ${name}`);
    return v;
  };
  const tableName = await param(n.param('tableName'));
  const sessionKey = await param(n.param('session_key'));
  const item = (
    await ddb.send(new GetItemCommand({ TableName: tableName, Key: eventKey(opts.eventToken) }))
  ).Item;
  if (!item) throw new Error('unknown event token');
  const event = eventFromItem(opts.eventToken, item);

  return {
    event,
    async mint() {
      const now = new Date();
      const { token, claims } = issueSession(sessionKey, now);
      await ddb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: sessionToItem({
            id: claims.id,
            eventToken: event.token,
            eventId: event.eventId,
            createdAt: now.toISOString(),
            expiresAt: claims.expiresAt,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return token;
    },
  };
}
