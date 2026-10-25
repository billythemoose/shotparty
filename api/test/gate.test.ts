import { describe, expect, it, vi } from 'vitest';
import { hashPin, type EventRecord } from '../src/lib/events.js';
import {
  checkUploadAllowed,
  gateErrorStatus,
  type GateDeps,
  type GateOptions,
  ttlCache,
} from '../src/lib/gate.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const event: EventRecord = {
  token: TOKEN,
  eventId: 'pizza-and-games-2026',
  name: 'Pizza & Games',
  openFrom: '2026-10-10T20:00:00Z',
  openUntil: '2026-11-10T20:00:00Z',
};

function deps(overrides: Partial<GateDeps> & { ev?: EventRecord | null } = {}): GateDeps {
  const ev = 'ev' in overrides ? overrides.ev : event;
  return {
    uploadsEnabled: async () => true,
    getEvent: vi.fn(async (t: string) => (t === TOKEN ? (ev ?? null) : null)),
    now: () => new Date('2026-10-11T00:00:00Z'),
    ...overrides,
  };
}

/** Returns the HTTP status and error code of a refusal; fails the test if the gate allowed it. */
async function refusal(
  input: { eventToken: unknown; pin: unknown },
  d: GateDeps,
  opts?: GateOptions,
): Promise<[number, string]> {
  const result = await checkUploadAllowed(input, d, opts);
  if (result.ok) throw new Error('expected a refusal');
  return [gateErrorStatus(result.error), result.error.kind];
}

describe('checkUploadAllowed', () => {
  it('allows a known, open event without a PIN', async () => {
    await expect(
      checkUploadAllowed({ eventToken: TOKEN, pin: undefined }, deps()),
    ).resolves.toEqual({ ok: true, value: event });
  });

  it('checks the kill switch first (503), before touching the event', async () => {
    const d = deps({ uploadsEnabled: async () => false });
    expect(await refusal({ eventToken: TOKEN, pin: undefined }, d)).toEqual([
      503,
      'uploads-disabled',
    ]);
    expect(d.getEvent).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 400, 'missing-event'],
    ['', 400, 'missing-event'],
    [42, 400, 'missing-event'],
    ['short', 404, 'unknown-event'],
    ['has spaces in it!!!!!!!', 404, 'unknown-event'],
    ['ZZZZZZZZZZZZZZZZZZZZZZ', 404, 'unknown-event'],
  ])('token %j -> %i %s', async (eventToken, status, error) => {
    expect(await refusal({ eventToken, pin: undefined }, deps())).toEqual([status, error]);
  });

  it('does not query the database for malformed tokens', async () => {
    const d = deps();
    await checkUploadAllowed({ eventToken: '../../etc', pin: undefined }, d);
    expect(d.getEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-10-10T19:00:00Z', 'not-yet-open'],
    ['2026-11-11T00:00:00Z', 'closed'],
  ])('at %s -> 403 %s', async (now, error) => {
    const d = deps({ now: () => new Date(now) });
    expect(await refusal({ eventToken: TOKEN, pin: undefined }, d)).toEqual([403, error]);
  });

  describe('with a PIN', () => {
    const ev = { ...event, pinHash: hashPin('482913') };
    it.each([
      [undefined, 'pin-required'],
      ['', 'pin-required'],
      ['000000', 'wrong-pin'],
    ])('pin %j -> 403 %s', async (pin, error) => {
      expect(await refusal({ eventToken: TOKEN, pin }, deps({ ev }))).toEqual([403, error]);
    });

    it('skips the PIN when the session already verified it', async () => {
      await expect(
        checkUploadAllowed({ eventToken: TOKEN, pin: undefined }, deps({ ev }), {
          pinAlreadyVerified: true,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('accepts the right PIN', async () => {
      await expect(
        checkUploadAllowed({ eventToken: TOKEN, pin: '482 913' }, deps({ ev })),
      ).resolves.toMatchObject({ ok: true });
    });
  });
});

describe('ttlCache', () => {
  it('reuses a value until it expires', async () => {
    let t = 0;
    const cache = ttlCache<number>(30_000, () => t);
    const load = vi.fn(async () => t);
    expect(await cache('k', load)).toBe(0);
    t = 29_999;
    expect(await cache('k', load)).toBe(0);
    t = 30_001;
    expect(await cache('k', load)).toBe(30_001);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
