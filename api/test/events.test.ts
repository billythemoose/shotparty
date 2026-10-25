import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/lib/quota.js';
import {
  effectiveLimits,
  EVENT_ID_PATTERN,
  eventFromItem,
  eventIdFromName,
  eventToItem,
  hashPin,
  newPin,
  newToken,
  normalizeDisplay,
  TOKEN_PATTERN,
  slugify,
  verifyPin,
  windowStatus,
  yearOf,
} from '../src/lib/events.js';

describe('tokens and PINs', () => {
  it('generates 128-bit URL-safe tokens that match the accepted pattern', () => {
    const tokens = new Set(Array.from({ length: 50 }, newToken));
    expect(tokens.size).toBe(50);
    for (const t of tokens) {
      expect(t).toMatch(TOKEN_PATTERN);
      expect(Buffer.from(t, 'base64url')).toHaveLength(16);
    }
  });

  it('generates zero-padded numeric PINs', () => {
    for (let i = 0; i < 50; i++) {
      expect(newPin()).toMatch(/^\d{6}$/);
    }
  });

  it('verifies the right PIN, tolerating spaces, dashes and case', () => {
    const stored = hashPin('123456');
    expect(verifyPin('123456', stored)).toBe(true);
    expect(verifyPin('123 456', stored)).toBe(true);
    expect(verifyPin('123-456', stored)).toBe(true);
    expect(hashPin('ab12') && verifyPin('AB12', hashPin('ab12'))).toBe(true);
  });

  it.each([['654321'], [''], [undefined], [123456], ['x'.repeat(33)]])('rejects %j', (pin) => {
    expect(verifyPin(pin, hashPin('123456'))).toBe(false);
  });

  it('salts hashes (same PIN, different stored values) and rejects malformed hashes', () => {
    expect(hashPin('123456')).not.toBe(hashPin('123456'));
    expect(verifyPin('123456', 'plain$abc')).toBe(false);
    expect(verifyPin('123456', '123456')).toBe(false);
  });
});

describe('windowStatus', () => {
  const event = { openFrom: '2026-10-10T20:00:00Z', openUntil: '2026-11-10T20:00:00Z' };
  it.each([
    ['2026-10-10T19:59:59Z', 'not-yet-open'],
    ['2026-10-10T20:00:00Z', 'open'],
    ['2026-10-25T00:00:00Z', 'open'],
    ['2026-11-10T20:00:00Z', 'open'],
    ['2026-11-10T20:00:01Z', 'closed'],
  ])('%s -> %s', (now, status) => {
    expect(windowStatus(event, new Date(now))).toBe(status);
  });
});

describe('eventIdFromName', () => {
  it.each([
    ['Pizza & Games', 2026, 'pizza-and-games-2026'],
    ["Zoë's Big Day!", 2027, 'zoe-s-big-day-2027'],
    ['🎉', 2026, 'event-2026'],
  ])('%s -> %s', (name, year, id) => {
    expect(eventIdFromName(name, year)).toBe(id);
  });
});

describe('slugify / EVENT_ID_PATTERN', () => {
  it.each([
    ['Pizza-and-Games', 'pizza-and-games'],
    ['  My Event  ', 'my-event'],
    ['../../etc/passwd', 'etc-passwd'],
    ['UPPER_case', 'upper-case'],
    ['!!!', ''],
  ])('%j -> %j', (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });

  it('only admits clean slugs', () => {
    expect(EVENT_ID_PATTERN.test('pizza-and-games-2026')).toBe(true);
    for (const bad of ['', '-x', 'x-', 'a--b', 'A', 'a/b', 'a b']) {
      expect(EVENT_ID_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('yearOf', () => {
  it.each([
    ['2026-12-31T18:00:00-08:00', 2026], // already 2027 in UTC
    ['2027-01-01T01:00:00+14:00', 2027], // still 2026 in UTC
    [' 2026-06-01 ', 2026],
  ])('%s -> %i', (input, year) => {
    expect(yearOf(input)).toBe(year);
  });

  it('falls back to the local year of now', () => {
    expect(yearOf(undefined, new Date(2031, 5, 1))).toBe(2031);
  });
});

describe('DynamoDB mapping', () => {
  const event = {
    token: 'tok_0123456789abcdef', // gitleaks:allow (a fake test token)
    eventId: 'pizza-and-games-2026',
    name: 'Pizza & Games',
    openFrom: '2026-10-10T20:00:00Z',
    openUntil: '2026-11-10T20:00:00Z',
  };

  it('round-trips with and without a PIN', () => {
    expect(eventFromItem(event.token, eventToItem(event))).toEqual(event);
    const withPin = { ...event, pinHash: hashPin('123456') };
    expect(eventFromItem(event.token, eventToItem(withPin))).toEqual(withPin);
  });

  it('stores under pk=EVENT#<token>, sk=META', () => {
    expect(eventToItem(event)).toMatchObject({
      pk: { S: 'EVENT#tok_0123456789abcdef' },
      sk: { S: 'META' },
    });
  });

  it('round-trips per-event limit overrides and merges them over the defaults', () => {
    const limited = { ...event, limits: { sessionFiles: 5, eventBytes: 1000 } };
    const back = eventFromItem(event.token, eventToItem(limited));
    expect(back).toEqual(limited);
    expect(effectiveLimits(back.limits)).toEqual({
      ...DEFAULT_LIMITS,
      sessionFiles: 5,
      eventBytes: 1000,
    });
    expect(effectiveLimits(undefined)).toEqual(DEFAULT_LIMITS);
  });

  it('round-trips the guest-page display fields, and omits them when unset', () => {
    const shown = {
      ...event,
      display: { headline: 'Say cheese', thanks: 'Thank you!', accentColor: '#1a2b3c' },
    };
    const item = eventToItem(shown);
    expect(item).toMatchObject({ display_headline: { S: 'Say cheese' } });
    expect(item).not.toHaveProperty('display_welcome');
    expect(eventFromItem(event.token, item)).toEqual(shown);
    expect(eventFromItem(event.token, eventToItem(event))).not.toHaveProperty('display');
  });

  it('fails loudly on a corrupt item', () => {
    expect(() => eventFromItem('t', { name: { S: 'x' } })).toThrow('eventId');
  });
});

describe('normalizeDisplay', () => {
  it('trims text, lowercases the color and drops empty values', () => {
    expect(
      normalizeDisplay({
        headline: '  Hi  ',
        welcome: '   ',
        accentColor: '#AABBCC',
        thanks: null,
      }),
    ).toEqual({ display: { headline: 'Hi', accentColor: '#aabbcc' }, problems: [] });
  });

  it('keeps markup as plain text (the page never interprets it)', () => {
    expect(normalizeDisplay({ welcome: '<b>hi</b>' }).display.welcome).toBe('<b>hi</b>');
  });

  it('reports every problem at once', () => {
    const { display, problems } = normalizeDisplay({
      headline: 'x'.repeat(81),
      welcome: 42,
      thanks: 'ok',
      accentColor: 'red',
    });
    expect(display).toEqual({ thanks: 'ok' });
    expect(problems).toEqual([
      'headline is longer than 80 characters',
      'welcome must be text',
      'accentColor must look like #1a2b3c (got "red")',
    ]);
  });

  it('counts characters, not UTF-16 units, so emoji are not penalized', () => {
    expect(normalizeDisplay({ headline: '📸'.repeat(80) }).problems).toEqual([]);
  });
});
