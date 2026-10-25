import { describe, expect, it } from 'vitest';
import {
  CloudflareError,
  ensureWidget,
  TurnstileApi,
  type Widget,
  withSiteKey,
} from '../lib/turnstile-widget.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/challenges/widgets`;

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  auth?: string;
}

interface FakeCloudflare {
  api: TurnstileApi;
  calls: RecordedCall[];
  widgets: Widget[];
}

/** A fake Cloudflare account holding `widgets`, recording every request. */
function fakeCloudflare(widgets: Widget[], opts: { status?: number } = {}): FakeCloudflare {
  const calls: RecordedCall[] = [];
  const reply = (status: number, result: unknown, extra: object = {}): Response =>
    new Response(
      JSON.stringify({
        success: status < 400,
        errors: status < 400 ? [] : [{ code: 10000, message: 'Authentication error' }],
        result,
        ...extra,
      }),
      { status },
    );
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const path = String(input).slice(BASE.length);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method,
      path,
      body,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    if (opts.status) return reply(opts.status, null);
    const listing = widgets.map((w) => ({ ...w, secret: undefined }));
    if (method === 'GET' && path.startsWith('?')) {
      const page = Number(/page=(\d+)/.exec(path)![1]);
      return reply(200, listing.slice((page - 1) * 50, page * 50), {
        result_info: { page, total_pages: Math.max(1, Math.ceil(listing.length / 50)) },
      });
    }
    const key = decodeURIComponent(path.slice(1));
    const w = widgets.find((x) => x.sitekey === key);
    if (method === 'GET') return w ? reply(200, w) : reply(404, null);
    if (method === 'POST') {
      const created = {
        ...body,
        sitekey: `0x4AAAA${widgets.length}`,
        secret: `0x4secret${widgets.length}`,
      };
      widgets.push(created);
      return reply(200, created);
    }
    if (method === 'PUT' && w) {
      Object.assign(w, body);
      return reply(200, { ...w, secret: undefined }); // update responses may leave the secret out
    }
    return reply(404, null);
  };
  return { api: new TurnstileApi(ACCOUNT, 'tok', fetchImpl), calls, widgets };
}

function existing(): Widget {
  return {
    sitekey: '0x4AAAexisting',
    secret: '0x4AAAsecret',
    name: 'shotparty',
    domains: ['d1.cloudfront.net'],
    mode: 'managed',
    clearance_level: 'no_clearance',
  };
}

describe('ensureWidget', () => {
  it('creates a managed widget named after the prefix when there is none', async () => {
    const cf = fakeCloudflare([]);
    const { widget, actions } = await ensureWidget(cf.api, {
      name: 'shotparty',
      host: 'd9.cloudfront.net',
    });
    expect(widget).toMatchObject({ sitekey: '0x4AAAA0', secret: '0x4secret0' });
    expect(actions).toEqual(['created widget "shotparty"']);
    expect(cf.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { name: 'shotparty', domains: ['d9.cloudfront.net'], mode: 'managed' },
      auth: 'Bearer tok',
    });
  });

  it('reuses the widget with the same name (a re-run after a crash), adding the host', async () => {
    const cf = fakeCloudflare([existing()]);
    const { widget, actions } = await ensureWidget(cf.api, {
      name: 'shotparty',
      host: 'd2.cloudfront.net',
    });
    expect(widget.sitekey).toBe('0x4AAAexisting');
    expect(widget.secret).toBe('0x4AAAsecret');
    expect(widget.domains).toEqual(['d1.cloudfront.net', 'd2.cloudfront.net']);
    expect(actions).toEqual([
      'reusing widget "shotparty"',
      'added d2.cloudfront.net to its hostnames',
    ]);
    // PUT replaces the widget: the existing settings go back unchanged.
    expect(cf.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      name: 'shotparty',
      mode: 'managed',
      domains: ['d1.cloudfront.net', 'd2.cloudfront.net'],
      clearance_level: 'no_clearance',
    });
  });

  it('changes nothing for a configured key whose widget already allows the host', async () => {
    const cf = fakeCloudflare([existing()]);
    const { widget, actions } = await ensureWidget(cf.api, {
      siteKey: '0x4AAAexisting',
      name: 'shotparty',
      host: 'd1.cloudfront.net',
    });
    expect(widget.secret).toBe('0x4AAAsecret');
    expect(actions).toEqual([]);
    expect(cf.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses a configured key the account does not have', async () => {
    const cf = fakeCloudflare([]);
    await expect(
      ensureWidget(cf.api, {
        siteKey: '0x4AAAtypo',
        name: 'shotparty',
        host: 'd1.cloudfront.net',
      }),
    ).rejects.toThrow(/no Turnstile widget with site key 0x4AAAtypo/);
  });

  it('explains a token without the Turnstile permission', async () => {
    const cf = fakeCloudflare([], { status: 403 });
    const result = ensureWidget(cf.api, { name: 'shotparty', host: 'd1.cloudfront.net' });
    await expect(result).rejects.toBeInstanceOf(CloudflareError);
    await expect(result).rejects.toThrow(
      /Authentication error \(10000\).*Account > Turnstile > Edit/,
    );
  });

  it('finds a widget on a later page of the listing', async () => {
    const many: Widget[] = Array.from({ length: 60 }, (_, i) => ({
      sitekey: `k${i}`,
      secret: `s${i}`,
      name: i === 55 ? 'shotparty' : `other-${i}`,
      domains: ['d1.cloudfront.net'],
      mode: 'managed',
    }));
    const cf = fakeCloudflare(many);
    const { widget } = await ensureWidget(cf.api, {
      name: 'shotparty',
      host: 'd1.cloudfront.net',
    });
    expect(widget).toMatchObject({ sitekey: 'k55', secret: 's55' });
  });
});

describe('withSiteKey', () => {
  it('sets the stage key and keeps every other setting', () => {
    const text = JSON.stringify({
      cloudflare: { accountId: ACCOUNT },
      stages: {
        dev: { turnstileSiteKey: '1x00000000000000000000BB' },
        prod: { accountBudget: true },
      },
    });
    expect(JSON.parse(withSiteKey(text, 'prod', '0x4AAAnew'))).toEqual({
      cloudflare: { accountId: ACCOUNT },
      stages: {
        dev: { turnstileSiteKey: '1x00000000000000000000BB' },
        prod: { accountBudget: true, turnstileSiteKey: '0x4AAAnew' },
      },
    });
  });

  it('refuses a stage the config does not define', () => {
    expect(() => withSiteKey('{"stages":{}}', 'prod', 'k')).toThrow(/no stages.prod/);
  });
});
