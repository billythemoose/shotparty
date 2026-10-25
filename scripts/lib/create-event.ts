import {
  TransactionCanceledException,
  type TransactWriteItemsCommandInput,
} from '@aws-sdk/client-dynamodb';
import { eventIdKey, type EventRecord, eventToItem } from '../../api/src/lib/events.js';

/**
 * Writes the event and reserves its event ID in one transaction. Both writes are conditional, so
 * an existing event (same token) or an event ID already used by another event aborts everything.
 */
export function createEventTransaction(
  tableName: string,
  event: EventRecord,
  createdAt: Date,
): TransactWriteItemsCommandInput {
  return {
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: { ...eventToItem(event), createdAt: { S: createdAt.toISOString() } },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          // Deliberately no token here: the reservation shouldn't be a second place it's stored.
          Item: {
            ...eventIdKey(event.eventId),
            name: { S: event.name },
            createdAt: { S: createdAt.toISOString() },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ],
  };
}

/** Turns a failed transaction into a message the organizer can act on; null for other errors. */
export function explainCreateFailure(e: Error, eventId: string): string | null {
  if (!(e instanceof TransactionCanceledException)) return null;
  const [eventReason, idReason] = e.CancellationReasons ?? [];
  if (idReason?.Code === 'ConditionalCheckFailed') {
    return (
      `event ID "${eventId}" is already used by another event, and its photos would mix ` +
      `in the same folder. Choose another with --event-id <id>.`
    );
  }
  if (eventReason?.Code === 'ConditionalCheckFailed') {
    return 'token collision (astronomically unlikely): just run the command again.';
  }
  return null;
}
