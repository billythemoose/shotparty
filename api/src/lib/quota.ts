/**
 * @fileoverview Upload quotas, reserved at presign time by bumping three counters (the whole event,
 * this IP this hour, this session), each a single-item conditional update. Not a transaction: the
 * event and venue-IP counters are shared by every guest, and concurrent transactions on one item
 * get canceled, whereas single-item updates are simply serialized. If a later counter is full,
 * the earlier increments are rolled back, so a refused request doesn't consume quota. Reservations
 * count presigns (not completed uploads), so a retried upload counts again; the limits are sized
 * with that headroom in mind.
 */
import { createHmac } from 'node:crypto';
import type { UpdateItemCommandInput } from '@aws-sdk/client-dynamodb';
import { assertIsError, err, type Failure, ok, type Result } from './result.js';

const GIB = 1024 ** 3;

/** Per-event upload limits; events may override any of them. */
export interface QuotaLimits {
  sessionFiles: number;
  sessionBytes: number;
  /** High on purpose: a whole venue on one Wi-Fi network shares a single public IP. */
  ipFilesPerHour: number;
  eventFiles: number;
  eventBytes: number;
}

/** Limits for events that don't set their own. */
export const DEFAULT_LIMITS: QuotaLimits = {
  sessionFiles: 500,
  sessionBytes: 10 * GIB,
  ipFilesPerHour: 3000,
  eventFiles: 20_000,
  eventBytes: 100 * GIB,
};

/** The counter that is full. The kind is also the API's `error` code. */
export type QuotaError =
  Failure<'session-quota'> | Failure<'ip-rate-limit'> | Failure<'event-quota'>;

/** Keyed hash of the IP bucket: counters never store raw addresses. */
export function ipHash(bucket: string, key: string): string {
  return createHmac('sha256', key).update(`ip:${bucket}`).digest('base64url').slice(0, 22);
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13); // 2026-10-10T20
}

/** What one presign reserves, and against which limits. */
export interface Reservation {
  tableName: string;
  sessionId: string;
  sessionExpiresAt: number; // epoch seconds (counter expires with the session)
  eventId: string;
  ipHash: string;
  size: number;
  now: Date;
  limits: QuotaLimits;
}

/** One counter's reserve and release, and the quota it enforces. */
export interface CounterUpdate {
  quota: QuotaError;
  /** Conditional increment: fails with ConditionalCheckFailedException when the counter is full. */
  reserve: UpdateItemCommandInput;
  /** Unconditional decrement that undoes `reserve` (used when a later counter is full). */
  release: UpdateItemCommandInput;
}

/** Returns the ordered counter updates, or the quota that can never fit this file (no writes). */
export function reservationUpdates(reservation: Reservation): Result<CounterUpdate[], QuotaError> {
  if (reservation.size > reservation.limits.sessionBytes) return err({ kind: 'session-quota' });
  if (reservation.size > reservation.limits.eventBytes) return err({ kind: 'event-quota' });

  const counter = (
    quota: QuotaError,
    pk: string,
    sk: string,
    maxFiles: number,
    maxBytes: number | null,
    ttl: number | null,
  ): CounterUpdate => {
    const key = { pk: { S: pk }, sk: { S: sk } };
    const values: Record<string, { N: string }> = {
      ':one': { N: '1' },
      ':size': { N: String(reservation.size) },
      ':maxFiles': { N: String(maxFiles) },
    };
    let condition = 'attribute_not_exists(files) OR files < :maxFiles';
    if (maxBytes !== null) {
      // bytes + size <= max, written as bytes <= max - size (no arithmetic in conditions).
      values[':room'] = { N: String(maxBytes - reservation.size) };
      condition = 'attribute_not_exists(files) OR (files < :maxFiles AND bytes <= :room)';
    }
    let update = 'ADD files :one, bytes :size';
    if (ttl !== null) {
      values[':ttl'] = { N: String(ttl) };
      update += ' SET #ttl = if_not_exists(#ttl, :ttl)';
    }
    return {
      quota,
      reserve: {
        TableName: reservation.tableName,
        Key: key,
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeValues: values,
        ...(ttl !== null ? { ExpressionAttributeNames: { '#ttl': 'ttl' } } : {}),
      },
      release: {
        TableName: reservation.tableName,
        Key: key,
        UpdateExpression: 'ADD files :minusOne, bytes :minusSize',
        ExpressionAttributeValues: {
          ':minusOne': { N: '-1' },
          ':minusSize': { N: String(-reservation.size) },
        },
      },
    };
  };

  const nowSeconds = Math.floor(reservation.now.getTime() / 1000);
  // Shared counters first: a full event or venue refuses before touching the session counter.
  return ok([
    counter(
      { kind: 'event-quota' },
      `QUOTA#${reservation.eventId}`,
      'TOTAL',
      reservation.limits.eventFiles,
      reservation.limits.eventBytes,
      null,
    ),
    counter(
      { kind: 'ip-rate-limit' },
      `IP#${reservation.ipHash}`,
      `HOUR#${hourKey(reservation.now)}`,
      reservation.limits.ipFilesPerHour,
      null,
      nowSeconds + 2 * 3600,
    ),
    counter(
      { kind: 'session-quota' },
      `SESSION#${reservation.sessionId}`,
      'QUOTA',
      reservation.limits.sessionFiles,
      reservation.limits.sessionBytes,
      reservation.sessionExpiresAt,
    ),
  ]);
}

/**
 * Applies the updates in order. On a full counter, rolls back the ones already applied and
 * returns that quota; any other error is rethrown after the same rollback.
 */
export async function reserveQuota(
  updates: CounterUpdate[],
  send: (input: UpdateItemCommandInput) => Promise<unknown>,
): Promise<Result<void, QuotaError>> {
  const applied: CounterUpdate[] = [];
  const rollback = async (): Promise<void> => {
    await Promise.allSettled(applied.map((u) => send(u.release))); // best effort
  };
  for (const update of updates) {
    try {
      await send(update.reserve);
      applied.push(update);
    } catch (e: unknown) {
      await rollback();
      assertIsError(e);
      if (e.name === 'ConditionalCheckFailedException') return err(update.quota);
      throw e;
    }
  }
  return ok(undefined);
}
