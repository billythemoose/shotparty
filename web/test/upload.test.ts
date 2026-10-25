import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  buildUploadForm,
  createSession,
  failureMessage,
  isRetryable,
  type PresignedPost,
  requestPresign,
  s3Error,
  type UploadFailure,
} from '../src/upload';
import type { Result } from '../src/result';

const presigned = {
  url: 'https://bucket.s3.us-east-1.amazonaws.com/',
  fields: { key: 'uploads/unassigned/anonymous/id.jpg', 'Content-Type': 'image/jpeg', Policy: 'p' },
  key: 'uploads/unassigned/anonymous/id.jpg',
};
const file = new File(['hello'], 'IMG_1.jpg', { type: 'image/jpeg' });

function respond(status: number, body: unknown): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

/** Returns the failure of a Result; fails the test if it succeeded. */
function failureOf<T>(result: Result<T, UploadFailure>): UploadFailure {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

function presign(fetchImpl: typeof fetch): Promise<Result<PresignedPost, UploadFailure>> {
  return requestPresign({ file, contentType: 'image/jpeg', session: 's' }, fetchImpl);
}

describe('buildUploadForm', () => {
  it('puts every policy field first and the file last', () => {
    const form = buildUploadForm(presigned.fields, new Blob(['x']));
    expect([...form.keys()]).toEqual(['key', 'Content-Type', 'Policy', 'file']);
  });
});

describe('requestPresign', () => {
  it('sends the session as a bearer token with name, type, size and guest name', async () => {
    const fetchImpl = respond(200, presigned);
    await expect(
      requestPresign(
        { file, contentType: 'image/jpeg', session: 'sess', guestName: 'May' },
        fetchImpl,
      ),
    ).resolves.toEqual({ ok: true, value: presigned });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/presign');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sess');
    expect(JSON.parse(String(init!.body))).toEqual({
      filename: 'IMG_1.jpg',
      contentType: 'image/jpeg',
      size: 5,
      guestName: 'May',
    });
  });

  it('omits an empty guest name', async () => {
    const fetchImpl = respond(200, presigned);
    await requestPresign(
      { file, contentType: 'image/jpeg', session: 's', guestName: '' },
      fetchImpl,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).not.toHaveProperty('guestName');
  });

  it('refuses a 2xx reply that is not a presigned POST', async () => {
    const failure = failureOf(await presign(respond(200, { url: 'x' })));
    expect(failure).toEqual({ kind: 'unexpected-response', url: '/api/presign' });
    expect(isRetryable(failure)).toBe(false);
  });

  it.each([
    [400, false],
    [429, true],
    [500, true],
    [503, true],
  ])('HTTP %i -> retryable=%s', async (status, retryable) => {
    const failure = failureOf(await presign(respond(status, { error: 'nope' })));
    expect(failure).toEqual({ kind: 'api-refused', status, code: 'nope' });
    expect(isRetryable(failure)).toBe(retryable);
  });

  it.each([
    ['wrong-pin', 403, 'wrong PIN, check your card'],
    ['pin-required', 403, 'enter the PIN from your card'],
    ['closed', 403, 'uploads have closed'],
    ['uploads-disabled', 503, 'uploads are paused, try again later'],
  ])('maps gate error %s to a friendly message', async (code, status, message) => {
    const failure = failureOf(await presign(respond(status, { error: code })));
    expect(failureMessage(failure)).toBe(message);
    expect(failure).toMatchObject({ code });
  });

  it.each([
    ['session-expired', 401],
    ['invalid-session', 401],
    ['verification-failed', 403],
  ])('%s is retryable (a fresh session/verification can fix it)', async (code, status) => {
    const failure = failureOf(await presign(respond(status, { error: code })));
    expect(isRetryable(failure)).toBe(true);
  });

  it.each([
    ['session-quota', 'upload limit reached for this phone'],
    ['ip-rate-limit', 'too many uploads from this network, try again in an hour'],
    ['event-quota', 'the album is full'],
  ])('quota %s -> 429, friendly message, not retried', async (code, message) => {
    const failure = failureOf(await presign(respond(429, { error: code })));
    expect(failureMessage(failure)).toBe(message);
    expect(isRetryable(failure)).toBe(false);
  });

  it('a plain 429 (API throttling) is still retried', async () => {
    const failure = failureOf(await presign(respond(429, { message: 'Too Many Requests' })));
    expect(isRetryable(failure)).toBe(true);
    expect(failureMessage(failure)).toBe('server error (HTTP 429)');
  });

  it('treats network failures as retryable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const failure = failureOf(await presign(fetchImpl));
    expect(failure).toEqual({ kind: 'network', message: 'network error' });
    expect(isRetryable(failure)).toBe(true);
  });
});

describe('s3Error', () => {
  function xml(code: string, message = ''): string {
    return `<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  }

  it.each([
    [400, xml('EntityTooLarge'), false, 'EntityTooLarge'],
    [
      403,
      xml('AccessDenied', 'Invalid according to Policy: Policy Condition failed'),
      false,
      'AccessDenied',
    ],
    [
      403,
      xml('AccessDenied', 'Invalid according to Policy: Policy expired.'),
      true,
      'AccessDenied',
    ],
    [400, xml('RequestTimeout'), true, 'RequestTimeout'],
    [503, xml('SlowDown'), true, 'SlowDown'],
    [0, '', true, 'HTTP 0'],
  ])('%i %s -> retryable=%s', (status, body, retryable, code) => {
    const failure = s3Error(status, body);
    expect(isRetryable(failure)).toBe(retryable);
    expect(failureMessage(failure)).toContain(code);
  });
});

describe('createSession', () => {
  it('posts event token, Turnstile token and PIN; returns the grant', async () => {
    const grant = { session: 'v1.a.b.c', expiresAt: 2_000_000_000 };
    const fetchImpl = respond(200, grant);
    await expect(
      createSession({ eventToken: 'tok', pin: '482913', turnstileToken: 'tt' }, fetchImpl),
    ).resolves.toEqual({ ok: true, value: grant });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/session');
    expect(JSON.parse(String(init!.body))).toEqual({
      eventToken: 'tok',
      pin: '482913',
      turnstileToken: 'tt',
    });
  });

  it('a wrong PIN is permanent (the guest must fix it)', async () => {
    const failure = failureOf(
      await createSession(
        { eventToken: 'tok', pin: '1', turnstileToken: 'tt' },
        respond(403, { error: 'wrong-pin' }),
      ),
    );
    expect(isRetryable(failure)).toBe(false);
    expect(failure).toMatchObject({ code: 'wrong-pin' });
  });
});

describe('failureMessage', () => {
  it('shows the verification problem as is', () => {
    const failure: UploadFailure = {
      kind: 'verification-unavailable',
      message: 'could not load human verification',
    };
    expect(failureMessage(failure)).toBe('could not load human verification');
    expect(isRetryable(failure)).toBe(true);
  });
});
