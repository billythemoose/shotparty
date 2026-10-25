import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventRecord } from '../src/lib/events.js';
import type { GateDeps } from '../src/lib/gate.js';

const PLAIN = 'AbCdEfGhIjKlMnOpQrStUv';
const STYLED = 'StYlEdEvEnTtOkEn012345';
vi.mock('../src/lib/secrets.js', () => ({ getSecret: async () => 'origin-secret' }));

const base: Omit<EventRecord, 'token'> = {
  eventId: 'summer-party-2026',
  name: 'Summer Party',
  openFrom: '2026-01-01T00:00:00Z',
  openUntil: '2099-01-01T00:00:00Z',
};
const events: Record<string, EventRecord> = {
  [PLAIN]: { token: PLAIN, ...base },
  [STYLED]: {
    token: STYLED,
    ...base,
    display: { headline: 'Say cheese', thanks: 'Thanks for coming!', accentColor: '#1a2b3c' },
  },
};
const gateDeps: GateDeps = {
  uploadsEnabled: async () => true,
  getEvent: async (t: string) => events[t] ?? null,
  now: () => new Date('2026-06-01T00:00:00Z'),
};
vi.mock('../src/lib/gate-deps.js', () => ({ gateDeps }));

const { handler } = await import('../src/handlers/event.js');

async function get(
  token: string,
): Promise<{ status: number | undefined; body: Record<string, unknown> }> {
  const res = await handler({
    pathParameters: { token },
    headers: { 'x-origin-verify': 'origin-secret' },
    requestContext: { http: { sourceIp: '203.0.113.9' } } as never,
  });
  return { status: res.statusCode, body: JSON.parse(res.body ?? '') };
}

describe('event handler', () => {
  beforeEach(() => vi.stubEnv('ORIGIN_VERIFY_PARAM', '/origin'));
  afterEach(() => vi.unstubAllEnvs());

  it("returns the event's own text and color", async () => {
    const { status, body } = await get(STYLED);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: 'Summer Party',
      status: 'open',
      display: { headline: 'Say cheese', thanks: 'Thanks for coming!', accentColor: '#1a2b3c' },
    });
  });

  it('returns an empty display for an event without customization', async () => {
    expect((await get(PLAIN)).body.display).toEqual({});
  });

  it('never exposes the PIN hash or the S3 folder', async () => {
    const { body } = await get(PLAIN);
    expect(body).not.toHaveProperty('pinHash');
    expect(body).not.toHaveProperty('eventId');
  });

  it('404s an unknown token', async () => {
    expect((await get('NoSuchEventToken000000')).status).toBe(404);
  });
});
