import type { UpdateItemCommandInput } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  type CounterUpdate,
  DEFAULT_LIMITS,
  ipHash,
  type Reservation,
  reservationUpdates,
  reserveQuota,
} from '../src/lib/quota.js';

const base: Reservation = {
  tableName: 't',
  sessionId: 'S'.repeat(22),
  sessionExpiresAt: 1_800_000_000,
  eventId: 'pizza-and-games-2026',
  ipHash: 'h'.repeat(22),
  size: 1000,
  now: new Date('2026-10-10T20:15:00Z'),
  limits: {
    ...DEFAULT_LIMITS,
    sessionFiles: 5,
    sessionBytes: 10_000,
    eventFiles: 100,
    eventBytes: 50_000,
  },
};

function updatesFor(reservation: Reservation = base): CounterUpdate[] {
  const res = reservationUpdates(reservation);
  if (!res.ok) throw new Error('expected updates');
  return res.value;
}

describe('reservationUpdates', () => {
  const updates = updatesFor();
  const [event, ip, session] = updates.map((u) => u.reserve);

  it('reserves shared counters first: event, IP-hour, then session', () => {
    expect(updates.map((u) => [u.quota.kind, u.reserve.Key!.pk!.S, u.reserve.Key!.sk!.S])).toEqual([
      ['event-quota', 'QUOTA#pizza-and-games-2026', 'TOTAL'],
      ['ip-rate-limit', `IP#${'h'.repeat(22)}`, 'HOUR#2026-10-10T20'],
      ['session-quota', `SESSION#${'S'.repeat(22)}`, 'QUOTA'],
    ]);
    for (const u of [event, ip, session]) {
      expect(u!.UpdateExpression).toMatch(/^ADD files :one, bytes :size/);
    }
  });

  it('guards files and bytes with room computed from the file size', () => {
    expect(session!.ConditionExpression).toBe(
      'attribute_not_exists(files) OR (files < :maxFiles AND bytes <= :room)',
    );
    expect(session!.ExpressionAttributeValues).toMatchObject({
      ':maxFiles': { N: '5' },
      ':room': { N: '9000' },
    });
    expect(event!.ExpressionAttributeValues).toMatchObject({ ':room': { N: '49000' } });
  });

  it('limits the IP counter by files only and expires it after 2 hours', () => {
    expect(ip!.ConditionExpression).toBe('attribute_not_exists(files) OR files < :maxFiles');
    expect(ip!.ExpressionAttributeValues![':ttl']).toEqual({
      N: String(Date.parse('2026-10-10T20:15:00Z') / 1000 + 7200),
    });
  });

  it('expires the session counter with the session; keeps event totals', () => {
    expect(session!.ExpressionAttributeValues![':ttl']).toEqual({ N: '1800000000' });
    expect(event!.UpdateExpression).not.toContain('ttl');
  });

  it('releases exactly what it reserved, unconditionally', () => {
    const release = updates[0]!.release;
    expect(release.Key).toEqual(event!.Key);
    expect(release.ConditionExpression).toBeUndefined();
    expect(release.ExpressionAttributeValues).toEqual({
      ':minusOne': { N: '-1' },
      ':minusSize': { N: '-1000' },
    });
  });

  it('refuses without writing when one file alone exceeds a byte limit', () => {
    expect(reservationUpdates({ ...base, size: 10_001 })).toEqual({
      ok: false,
      error: { kind: 'session-quota' },
    });
    expect(
      reservationUpdates({ ...base, size: 60_000, limits: { ...base.limits, sessionBytes: 1e9 } }),
    ).toEqual({ ok: false, error: { kind: 'event-quota' } });
  });
});

describe('reserveQuota', () => {
  const full = (): Error =>
    Object.assign(new Error('full'), { name: 'ConditionalCheckFailedException' });
  const pkOf = (i: UpdateItemCommandInput): string | undefined => i.Key!.pk!.S!.split('#')[0];

  it('applies all three when every counter has room', async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(reserveQuota(updatesFor(), send)).resolves.toEqual({ ok: true, value: undefined });
    expect(send.mock.calls.map(([i]) => pkOf(i))).toEqual(['QUOTA', 'IP', 'SESSION']);
  });

  it.each([
    [0, 'event-quota', []],
    [1, 'ip-rate-limit', ['QUOTA']],
    [2, 'session-quota', ['QUOTA', 'IP']],
  ])('counter %i full -> %s, and rolls back %j', async (failAt, error, rolledBack) => {
    let n = 0;
    const send = vi.fn(async (input: UpdateItemCommandInput) => {
      if (input.ConditionExpression && n++ === failAt) throw full();
      return {};
    });
    await expect(reserveQuota(updatesFor(), send)).resolves.toEqual({
      ok: false,
      error: { kind: error },
    });
    const releases = send.mock.calls.map(([i]) => i).filter((i) => !i.ConditionExpression);
    expect(releases.map(pkOf).sort()).toEqual([...rolledBack].sort());
  });

  it('rolls back and rethrows unexpected errors (e.g. throttling)', async () => {
    let n = 0;
    const send = vi.fn(async (input: UpdateItemCommandInput) => {
      if (input.ConditionExpression && n++ === 1) throw new Error('ProvisionedThroughputExceeded');
      return {};
    });
    await expect(reserveQuota(updatesFor(), send)).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(send.mock.calls.filter(([i]) => !i.ConditionExpression)).toHaveLength(1);
  });

  it('many concurrent reservations on the same shared counters all succeed (no transactions)', async () => {
    // Model DynamoDB single-item semantics: conditional updates on one item are serialized.
    const counters = new Map<string, number>();
    const send = async (input: UpdateItemCommandInput): Promise<object> => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      const k = `${input.Key!.pk!.S}|${input.Key!.sk!.S}`;
      const delta = Number(
        (input.ExpressionAttributeValues![':one'] ?? input.ExpressionAttributeValues![':minusOne'])!
          .N,
      );
      counters.set(k, (counters.get(k) ?? 0) + delta);
      return {};
    };
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        reserveQuota(
          updatesFor({
            ...base,
            sessionId: `S${String(i).padStart(21, '0')}`,
            limits: DEFAULT_LIMITS,
          }),
          send,
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(counters.get('QUOTA#pizza-and-games-2026|TOTAL')).toBe(60);
  });
});

describe('ipHash', () => {
  it('is stable per key and never contains the raw address', () => {
    expect(ipHash('203.0.113.9', 'k')).toBe(ipHash('203.0.113.9', 'k'));
    expect(ipHash('203.0.113.9', 'k')).not.toBe(ipHash('203.0.113.9', 'other'));
    expect(ipHash('203.0.113.9', 'k')).not.toContain('203');
  });
});
