import { describe, expect, it } from 'vitest';
import {
  issueSession,
  SESSION_TTL_SECONDS,
  sessionFromItem,
  sessionToItem,
  verifySession,
} from '../src/lib/session.js';

const KEY = 'k'.repeat(43);
const now = new Date('2026-10-10T20:00:00Z');

describe('session tokens', () => {
  it('round-trips, with or without a "Bearer " prefix', () => {
    const { token, claims } = issueSession(KEY, now);
    expect(claims.expiresAt).toBe(now.getTime() / 1000 + SESSION_TTL_SECONDS);
    expect(verifySession(token, KEY, now)).toEqual({ ok: true, value: claims });
    expect(verifySession(`Bearer ${token}`, KEY, now)).toEqual({ ok: true, value: claims });
  });

  it('issues unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => issueSession(KEY, now).claims.id));
    expect(ids.size).toBe(50);
  });

  it('requires a token', () => {
    expect(verifySession(undefined, KEY, now)).toEqual({
      ok: false,
      error: { kind: 'session-required' },
    });
    expect(verifySession('', KEY, now)).toEqual({ ok: false, error: { kind: 'session-required' } });
  });

  it('rejects tampering with any part', () => {
    const { token } = issueSession(KEY, now);
    const [v, id, exp, sig] = token.split('.');
    const forged = [
      `${v}.${id}.${Number(exp) + 3600}.${sig}`, // extended expiry
      `${v}.${'A'.repeat(22)}.${exp}.${sig}`, // swapped id
      `${v}.${id}.${exp}.${sig!.slice(0, -1)}${sig!.endsWith('A') ? 'B' : 'A'}`, // flipped sig
      `v2.${id}.${exp}.${sig}`,
      `${v}.${id}.${exp}`,
      'x'.repeat(300),
    ];
    for (const t of forged) {
      expect(verifySession(t, KEY, now)).toMatchObject({
        ok: false,
        error: { kind: 'invalid-session' },
      });
    }
  });

  it('rejects tokens signed with another key', () => {
    const { token } = issueSession('other-key', now);
    expect(verifySession(token, KEY, now)).toMatchObject({ error: { kind: 'invalid-session' } });
  });

  it('expires', () => {
    const { token } = issueSession(KEY, now, 60);
    expect(verifySession(token, KEY, new Date(now.getTime() + 59_000)).ok).toBe(true);
    expect(verifySession(token, KEY, new Date(now.getTime() + 60_000))).toEqual({
      ok: false,
      error: { kind: 'session-expired' },
    });
  });
});

describe('session record mapping', () => {
  it('round-trips and uses ttl for DynamoDB expiry', () => {
    const rec = {
      id: 'A'.repeat(22),
      eventToken: 'tok',
      eventId: 'pizza-and-games-2026',
      createdAt: now.toISOString(),
      expiresAt: 1790000000,
    };
    const item = sessionToItem(rec);
    expect(item.pk).toEqual({ S: `SESSION#${'A'.repeat(22)}` });
    expect(item.ttl).toEqual({ N: '1790000000' });
    expect(sessionFromItem(rec.id, item)).toEqual(rec);
  });
});
