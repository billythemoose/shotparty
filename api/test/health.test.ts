import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthBody } from '../src/lib/health.js';
import { handler } from '../src/handlers/health.js';

describe('healthBody', () => {
  it('reports stage, bucket and ISO time', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(healthBody('dev', 'media-bucket', now)).toEqual({
      status: 'ok',
      stage: 'dev',
      mediaBucket: 'media-bucket',
      time: '2026-09-24T12:00:00.000Z',
    });
  });
});

describe('health handler', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns 200 JSON from env config', async () => {
    vi.stubEnv('STAGE', 'dev');
    vi.stubEnv('MEDIA_BUCKET', 'media-bucket');
    const res = await handler();
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(res.body ?? '')).toMatchObject({ stage: 'dev', mediaBucket: 'media-bucket' });
  });

  it('fails loudly when config is missing', async () => {
    vi.stubEnv('STAGE', '');
    await expect(handler()).rejects.toThrow('STAGE');
  });
});
