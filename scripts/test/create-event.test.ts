import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createEventTransaction, explainCreateFailure } from '../lib/create-event.js';

const event = {
  token: 'AbCdEfGhIjKlMnOpQrStUv',
  eventId: 'pizza-and-games-2026',
  name: 'Pizza & Games',
  openFrom: '2026-10-10T20:00:00.000Z',
  openUntil: '2026-11-10T20:00:00.000Z',
};

describe('createEventTransaction', () => {
  const tx = createEventTransaction('table', event, new Date('2026-09-25T00:00:00Z'));
  const [eventPut, idPut] = tx.TransactItems!.map((i) => i.Put!);

  it('writes the event and reserves its ID, both only if absent', () => {
    expect(eventPut!.Item).toMatchObject({
      pk: { S: 'EVENT#AbCdEfGhIjKlMnOpQrStUv' },
      eventId: { S: 'pizza-and-games-2026' },
    });
    expect(idPut!.Item).toMatchObject({
      pk: { S: 'EVENTID#pizza-and-games-2026' },
      sk: { S: 'META' },
    });
    expect(eventPut!.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(idPut!.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('keeps the secret token out of the ID reservation', () => {
    expect(JSON.stringify(idPut!.Item)).not.toContain(event.token);
  });
});

describe('explainCreateFailure', () => {
  const canceled = (codes: string[]): TransactionCanceledException =>
    new TransactionCanceledException({
      message: 'Transaction canceled',
      $metadata: {},
      CancellationReasons: codes.map((code) => ({ Code: code })),
    });

  it('explains a taken event ID and suggests --event-id', () => {
    expect(explainCreateFailure(canceled(['None', 'ConditionalCheckFailed']), 'x-2026')).toMatch(
      /"x-2026" is already used.*--event-id/,
    );
  });

  it('explains a token collision', () => {
    expect(explainCreateFailure(canceled(['ConditionalCheckFailed', 'None']), 'x')).toMatch(
      /token collision/,
    );
  });

  it('leaves other errors alone', () => {
    expect(explainCreateFailure(new Error('network'), 'x')).toBeNull();
  });
});
