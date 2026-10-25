/**
 * @fileoverview Mocks everything the guest page talks to, per test: the API, S3 and the Turnstile
 * script.
 */
import type { Page, Request } from '@playwright/test';

export const S3_URL = 'https://media-bucket.s3.us-east-1.amazonaws.com/';

export interface EventOverrides {
  name?: string;
  status?: 'not-yet-open' | 'open' | 'closed';
  requiresPin?: boolean;
  uploadsEnabled?: boolean;
  display?: Record<string, string>;
}

/** S3's reply to one upload: 204 on success, or a status plus an S3 error code. */
export type S3Reply = { status: 204 } | { status: number; code: string; message?: string };

export interface ApiMock {
  sessionBodies: Array<Record<string, unknown>>;
  presignBodies: Array<Record<string, unknown>>;
  /** Upload replies are taken from this list in order; when it's empty, uploads succeed. */
  s3Replies: S3Reply[];
  /** Error code for /api/session to answer with (e.g. "wrong-pin"); null lets it succeed. */
  sessionError: string | null;
}

// Stands in for https://challenges.cloudflare.com/turnstile/v0/api.js: always passes.
const TURNSTILE_STUB = `
  window.turnstile = (() => {
    const widgets = {};
    let next = 0;
    return {
      render(el, opts) { const id = String(++next); widgets[id] = opts; return id; },
      execute(id) { setTimeout(() => widgets[id].callback('e2e-turnstile-token'), 0); },
      reset() {},
    };
  })();`;

interface JsonReply {
  status: number;
  contentType: string;
  body: string;
}

function json(status: number, body: unknown): JsonReply {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function bodyOf(req: Request): Record<string, unknown> {
  // The page only ever posts JSON objects.
  return (req.postDataJSON() ?? {}) as Record<string, unknown>;
}

/** Event 404s for any token other than `token`. */
export async function mockApi(
  page: Page,
  { token = 'e2e', event = {} }: { token?: string; event?: EventOverrides | null } = {},
): Promise<ApiMock> {
  const mock: ApiMock = { sessionBodies: [], presignBodies: [], s3Replies: [], sessionError: null };
  const day = 86_400_000;
  let uploads = 0;

  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB }),
  );
  await page.route('**/api/health', (route) =>
    route.fulfill(json(200, { ok: true, stage: 'e2e' })),
  );
  await page.route('**/api/event/*', (route) => {
    if (!event || !route.request().url().endsWith(`/api/event/${token}`)) {
      return route.fulfill(json(404, { error: 'unknown-event' }));
    }
    return route.fulfill(
      json(200, {
        name: 'E2E Party',
        display: {},
        requiresPin: false,
        status: 'open',
        openFrom: new Date(Date.now() - day).toISOString(),
        openUntil: new Date(Date.now() + day).toISOString(),
        uploadsEnabled: true,
        turnstileSiteKey: '1x00000000000000000000AA',
        ...event,
      }),
    );
  });
  await page.route('**/api/session', (route) => {
    mock.sessionBodies.push(bodyOf(route.request()));
    if (mock.sessionError) return route.fulfill(json(403, { error: mock.sessionError }));
    return route.fulfill(
      json(200, { session: 'e2e-session', expiresAt: Math.floor(Date.now() / 1000) + 43_200 }),
    );
  });
  await page.route('**/api/presign', (route) => {
    const body = bodyOf(route.request());
    mock.presignBodies.push(body);
    const key = `uploads/e2e/guest/${++uploads}-${String(body.filename)}`;
    return route.fulfill(
      json(200, { url: S3_URL, key, fields: { key, 'Content-Type': String(body.contentType) } }),
    );
  });
  await page.route(S3_URL, (route) => {
    const reply = mock.s3Replies.shift() ?? { status: 204 };
    const cors = { 'access-control-allow-origin': '*' };
    if (reply.status === 204) return route.fulfill({ status: 204, headers: cors });
    const { code, message = '' } = 'code' in reply ? reply : { code: '', message: '' };
    return route.fulfill({
      status: reply.status,
      headers: cors,
      contentType: 'application/xml',
      body: `<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    });
  });
  return mock;
}

/** A tiny "photo": the page only looks at the name and type, the mocked S3 accepts anything. */
export function photo(
  name: string,
  type = 'image/jpeg',
): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name,
    mimeType: type,
    buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(name)]),
  };
}
