import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  describeTurnstileError,
  SITEVERIFY_URL,
  type TurnstileError,
  verifyTurnstile,
} from '../src/lib/turnstile.js';

function reply(body: unknown): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
}
const strict = { action: 'upload-session', hostnames: ['photos.example.com'] };
const lax = { action: 'upload-session', hostnames: [] };

describe('verifyTurnstile', () => {
  it('posts secret, token and IP to siteverify', async () => {
    const f = reply({ success: true, hostname: 'photos.example.com', action: 'upload-session' });
    await expect(
      verifyTurnstile({ secret: 's', token: 't', remoteIp: '203.0.113.9' }, strict, f),
    ).resolves.toEqual({ ok: true, value: undefined });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
      secret: 's',
      response: 't',
      remoteip: '203.0.113.9',
    });
  });

  it.each([
    [undefined, 'missing-token'],
    ['', 'missing-token'],
    ['x'.repeat(2049), 'invalid-token'],
  ])('rejects token %j without calling Cloudflare', async (token, reason) => {
    const f = vi.fn();
    await expect(verifyTurnstile({ secret: 's', token }, strict, f)).resolves.toEqual({
      ok: false,
      error: { kind: reason },
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('reports Cloudflare error codes (e.g. a replayed token)', async () => {
    const f = reply({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    await expect(verifyTurnstile({ secret: 's', token: 't' }, strict, f)).resolves.toEqual({
      ok: false,
      error: { kind: 'rejected', codes: ['timeout-or-duplicate'] },
    });
  });

  it.each([
    [{ success: true, hostname: 'evil.example', action: 'upload-session' }, 'unexpected-hostname'],
    [{ success: true, hostname: 'photos.example.com', action: 'login' }, 'unexpected-action'],
  ])('enforces hostname and action when configured', async (body, reason) => {
    const res = await verifyTurnstile({ secret: 's', token: 't' }, strict, reply(body));
    expect(res.ok === false && res.error.kind).toBe(reason);
  });

  it('skips hostname/action checks when no hostnames are configured (test keys)', async () => {
    const f = reply({ success: true, hostname: 'example.com' });
    await expect(verifyTurnstile({ secret: 's', token: 't' }, lax, f)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('fails closed when Cloudflare is unreachable', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('network'));
    await expect(verifyTurnstile({ secret: 's', token: 't' }, strict, f)).resolves.toEqual({
      ok: false,
      error: { kind: 'siteverify-unreachable' },
    });
  });
});

describe('describeTurnstileError', () => {
  const cases: Array<[TurnstileError, string]> = [
    [{ kind: 'missing-token' }, 'missing-token'],
    [{ kind: 'rejected', codes: ['a', 'b'] }, 'a,b'],
    [{ kind: 'rejected', codes: [] }, 'failed'],
    [{ kind: 'unexpected-hostname', hostname: 'evil.example' }, 'unexpected-hostname:evil.example'],
    [{ kind: 'unexpected-action', action: '' }, 'unexpected-action:'],
  ];
  it.each(cases)('logs %j as %s', (error, reason) => {
    expect(describeTurnstileError(error)).toBe(reason);
  });
});
