/**
 * @fileoverview Upload sessions: issued once a guest passes Turnstile (+ PIN), then required by
 * every presign. Token format: v1.<id>.<expiresEpochSeconds>.<hmac>, HMAC-SHA256 over
 * "v1.<id>.<exp>" with a secret key (SSM SecureString). The signature lets presign reject
 * forged/tampered/expired tokens without a database read; the DynamoDB record ties the session to
 * its event (and to quotas).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AttributeMap, ItemKey } from './events.js';
import { err, type Failure, ok, type Result } from './result.js';

/** How long a session lasts. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const VERSION = 'v1';

/** What a session token carries. */
export interface SessionClaims {
  id: string;
  expiresAt: number; // epoch seconds
}

function sign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** Returns a new signed session token and its claims. */
export function issueSession(
  key: string,
  now: Date,
  ttlSeconds = SESSION_TTL_SECONDS,
): { token: string; claims: SessionClaims } {
  const id = randomBytes(16).toString('base64url');
  const expiresAt = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload = `${VERSION}.${id}.${expiresAt}`;
  return { token: `${payload}.${sign(key, payload)}`, claims: { id, expiresAt } };
}

/** Why a session token was refused. The kind is also the API's `error` code. */
export type SessionError =
  Failure<'session-required'> | Failure<'invalid-session'> | Failure<'session-expired'>;

/** Checks an `Authorization: Bearer <token>` header's signature and expiry (no database read). */
export function verifySession(
  header: string | undefined,
  key: string,
  now: Date,
): Result<SessionClaims, SessionError> {
  if (!header) return err({ kind: 'session-required' });
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token.length > 256) return err({ kind: 'invalid-session' });

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return err({ kind: 'invalid-session' });
  // parts has exactly four elements: checked just above.
  const [, id, exp, sig] = parts as [string, string, string, string];
  if (!/^[A-Za-z0-9_-]{22}$/.test(id) || !/^\d{1,12}$/.test(exp)) {
    return err({ kind: 'invalid-session' });
  }

  const expected = Buffer.from(sign(key, `${VERSION}.${id}.${exp}`));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return err({ kind: 'invalid-session' });
  }

  const expiresAt = Number(exp);
  if (expiresAt * 1000 <= now.getTime()) return err({ kind: 'session-expired' });
  return ok({ id, expiresAt });
}

// ---------- DynamoDB record (pk=SESSION#<id>, sk=META; expires via the table's TTL) ----------

/** A session as stored in DynamoDB. */
export interface SessionRecord {
  id: string;
  eventToken: string;
  eventId: string;
  createdAt: string;
  expiresAt: number;
}

/** Returns the key of a session's item. */
export function sessionKey(id: string): ItemKey {
  return { pk: { S: `SESSION#${id}` }, sk: { S: 'META' } };
}

/** Returns the DynamoDB item for a session; `ttl` lets the table expire it. */
export function sessionToItem(s: SessionRecord): Record<string, { S: string } | { N: string }> {
  return {
    ...sessionKey(s.id),
    eventToken: { S: s.eventToken },
    eventId: { S: s.eventId },
    createdAt: { S: s.createdAt },
    ttl: { N: String(s.expiresAt) },
  };
}

/** Reads a session item back; throws if a required attribute is missing (a corrupt item). */
export function sessionFromItem(id: string, item: AttributeMap): SessionRecord {
  const s = (k: string): string => {
    const v = item[k]?.S;
    if (v === undefined) throw new Error(`session item missing ${k}`);
    return v;
  };
  return {
    id,
    eventToken: s('eventToken'),
    eventId: s('eventId'),
    createdAt: s('createdAt'),
    expiresAt: Number(item.ttl?.N ?? 0),
  };
}
