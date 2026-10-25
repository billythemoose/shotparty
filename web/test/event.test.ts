import { describe, expect, it, type Mock, vi } from 'vitest';
import { eventTokenFromPath, loadEvent } from '../src/event';

describe('eventTokenFromPath', () => {
  it.each([
    ['/e/abc123', 'abc123'],
    ['/e/abc-123_XYZ/', 'abc-123_XYZ'],
  ])('extracts token from %s', (path, token) => {
    expect(eventTokenFromPath(path)).toBe(token);
  });

  it.each(['/', '/e/', '/e', '/x/abc', '/e/abc/extra', '/e/a%20b'])('rejects %s', (path) => {
    expect(eventTokenFromPath(path)).toBeNull();
  });
});

describe('loadEvent', () => {
  const info = {
    name: 'Pizza & Games',
    requiresPin: true,
    status: 'open',
    openFrom: '2026-10-10T20:00:00Z',
    openUntil: '2026-11-10T20:00:00Z',
    uploadsEnabled: true,
    turnstileSiteKey: '1x00000000000000000000AA',
  };
  const respond = (status: number, body: unknown = {}): Mock<typeof fetch> =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('asks guests to scan the QR code when there is no token', async () => {
    const fetchImpl = vi.fn();
    await expect(loadEvent(null, fetchImpl)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('QR code to share') },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is ready for an open event', async () => {
    await expect(loadEvent('tok', respond(200, info))).resolves.toEqual({ ok: true, value: info });
  });

  it.each([
    [404, {}, 'isn’t valid'],
    [500, {}, 'Something went wrong'],
    [200, { ...info, status: 'archived' }, 'Something went wrong'],
    [200, { ...info, display: { headline: 42 } }, 'Something went wrong'],
    [200, { ...info, status: 'closed' }, 'have closed'],
    [200, { ...info, status: 'not-yet-open' }, 'Uploads open DATE'],
    [200, { ...info, uploadsEnabled: false }, 'paused'],
  ])('HTTP %i %j -> blocked', async (status, body, text) => {
    const result = await loadEvent('tok', respond(status, body), () => 'DATE');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain(text);
  });

  it('reports network failures', async () => {
    const result = await loadEvent(
      'tok',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')),
    );
    expect(!result.ok && result.error.message).toContain('connection');
  });
});

describe('loadEvent for a closed event', () => {
  it('still returns the event, so the page can show its name and colors', async () => {
    const body = {
      name: 'Done',
      requiresPin: false,
      status: 'closed',
      openFrom: '2026-10-10T20:00:00Z',
      openUntil: '2026-11-10T20:00:00Z',
      uploadsEnabled: true,
      turnstileSiteKey: 'k',
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const result = await loadEvent('tok', fetchImpl);
    expect(!result.ok && result.error.event).toEqual(body);
  });
});
