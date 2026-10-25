import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPin } from '../src/lib/events.js';
import type { GateDeps } from '../src/lib/gate.js';
import { verifySession } from '../src/lib/session.js';
import type * as Turnstile from '../src/lib/turnstile.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const secrets: Record<string, string> = {
  '/turnstile': 'ts-secret',
  '/session': 'session-key',
  '/origin': 'origin-secret',
};
vi.mock('../src/lib/secrets.js', () => ({ getSecret: async (name: string) => secrets[name] }));

const saveSession = vi.fn();
vi.mock('../src/lib/session-store.js', () => ({ saveSession }));

const verifyTurnstile = vi.fn();
vi.mock('../src/lib/turnstile.js', async (orig) => ({
  ...(await orig<typeof Turnstile>()),
  verifyTurnstile,
}));

const gateDeps: GateDeps = {
  uploadsEnabled: async () => true,
  getEvent: vi.fn(async (t: string) =>
    t === TOKEN
      ? {
          token: TOKEN,
          eventId: 'pizza-and-games-2026',
          name: 'Pizza & Games',
          pinHash: hashPin('482913'),
          openFrom: '2026-01-01T00:00:00Z',
          openUntil: '2099-01-01T00:00:00Z',
        }
      : null,
  ),
  now: () => new Date(),
};
vi.mock('../src/lib/gate-deps.js', () => ({ gateDeps }));

const { handler } = await import('../src/handlers/session.js');

function call(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<APIGatewayProxyStructuredResultV2> {
  return handler({
    body: JSON.stringify(body),
    isBase64Encoded: false,
    headers: { 'x-origin-verify': 'origin-secret', ...headers },
    requestContext: { http: { sourceIp: '203.0.113.9' } } as never,
  });
}

describe('session handler', () => {
  beforeEach(() => {
    vi.stubEnv('TURNSTILE_SECRET_PARAM', '/turnstile');
    vi.stubEnv('SESSION_KEY_PARAM', '/session');
    vi.stubEnv('ORIGIN_VERIFY_PARAM', '/origin');
    vi.stubEnv('TURNSTILE_HOSTNAMES', 'photos.example.com, localhost');
    verifyTurnstile.mockResolvedValue({ ok: true, value: undefined });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('issues a verifiable session and stores it with its event', async () => {
    const res = await call({ eventToken: TOKEN, pin: '482913', turnstileToken: 'tt' });
    expect(res.statusCode).toBe(200);
    const { session, expiresAt } = JSON.parse(res.body ?? '');
    const check = verifySession(session, 'session-key', new Date());
    expect(check.ok).toBe(true);
    expect(check.ok && check.value.expiresAt).toBe(expiresAt);
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ eventToken: TOKEN, eventId: 'pizza-and-games-2026', expiresAt }),
    );
  });

  it('verifies Turnstile with the secret, client IP, action and hostnames', async () => {
    await call({ eventToken: TOKEN, pin: '482913', turnstileToken: 'tt' });
    expect(verifyTurnstile).toHaveBeenCalledWith(
      { secret: 'ts-secret', token: 'tt', remoteIp: '203.0.113.9' },
      { action: 'upload-session', hostnames: ['photos.example.com', 'localhost'] },
    );
  });

  it('sends Turnstile the real viewer IP when the request came through CloudFront', async () => {
    await call(
      { eventToken: TOKEN, pin: '482913', turnstileToken: 'tt' },
      { 'x-viewer-ip': '198.51.100.23' },
    );
    expect(verifyTurnstile.mock.calls[0]![0].remoteIp).toBe('198.51.100.23');
  });

  it('checks Turnstile BEFORE the PIN, so PIN guesses need a human each time', async () => {
    verifyTurnstile.mockResolvedValue({
      ok: false,
      error: { kind: 'rejected', codes: ['timeout-or-duplicate'] },
    });
    const res = await call({ eventToken: TOKEN, pin: '000000', turnstileToken: 'tt' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body ?? '').error).toBe('verification-failed');
    expect(gateDeps.getEvent).not.toHaveBeenCalled(); // never reached the PIN check
    expect(saveSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ pin: '000000' }, 403, 'wrong-pin'],
    [{}, 403, 'pin-required'],
    [{ eventToken: 'ZZZZZZZZZZZZZZZZZZZZZZ', pin: '482913' }, 404, 'unknown-event'],
  ])('gate failure %j -> %i %s, no session', async (extra, status, error) => {
    const res = await call({ eventToken: TOKEN, turnstileToken: 'tt', ...extra });
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body ?? '').error).toBe(error);
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('rejects non-object bodies', async () => {
    const res = await handler({
      body: '[1]',
      isBase64Encoded: false,
      headers: { 'x-origin-verify': 'origin-secret' },
      requestContext: {} as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects direct (non-CloudFront) calls before touching Turnstile', async () => {
    const res = await call(
      { eventToken: TOKEN, pin: '482913', turnstileToken: 'tt' },
      { 'x-origin-verify': 'forged' },
    );
    expect(res.statusCode).toBe(403);
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});
