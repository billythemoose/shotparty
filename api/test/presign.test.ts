import type * as DynamoDb from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDeps } from '../src/lib/gate.js';
import { issueSession, type SessionRecord } from '../src/lib/session.js';

const KEY = 'test-session-key';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

const createPresignedPost = vi.fn();
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost }));
const ORIGIN = 'origin-secret';
vi.mock('../src/lib/secrets.js', () => ({
  getSecret: async (name: string) => (name === '/origin' ? ORIGIN : KEY),
}));

// DynamoDB: record counter updates; optionally make one counter "full" (conditional check fails).
interface RecordedUpdate {
  Key: { pk: { S: string } };
  ConditionExpression?: string;
}
const updates: RecordedUpdate[] = [];
let fullCounter: string | null = null; // pk prefix: 'QUOTA' | 'IP' | 'SESSION'
vi.mock('@aws-sdk/client-dynamodb', async (orig) => {
  const actual = await orig<typeof DynamoDb>();
  return {
    ...actual,
    DynamoDBClient: class {
      async send(cmd: { input: RecordedUpdate }): Promise<object> {
        const input = cmd.input;
        if (
          fullCounter &&
          input.ConditionExpression &&
          input.Key.pk.S.startsWith(`${fullCounter}#`)
        ) {
          throw Object.assign(new Error('full'), { name: 'ConditionalCheckFailedException' });
        }
        updates.push(input);
        return {};
      }
    },
  };
});
const reservations = {
  get length() {
    return updates.filter((u) => u.ConditionExpression).length;
  },
};

const sessions = new Map<string, SessionRecord>();
vi.mock('../src/lib/session-store.js', () => ({
  loadSession: async (id: string) => sessions.get(id) ?? null,
}));

const openEvent = {
  token: TOKEN,
  eventId: 'pizza-and-games-2026',
  name: 'Pizza & Games',
  pinHash: 'scrypt$irrelevant$because-session-verified-it',
  openFrom: '2026-01-01T00:00:00Z',
  openUntil: '2099-01-01T00:00:00Z',
};
const gateDeps: GateDeps = {
  uploadsEnabled: vi.fn(async () => true),
  getEvent: vi.fn(async (t: string) => (t === TOKEN ? openEvent : null)),
  now: () => new Date(),
};
vi.mock('../src/lib/gate-deps.js', () => ({ gateDeps }));

const { handler } = await import('../src/handlers/presign.js');

function newSession(overrides: Partial<SessionRecord> = {}): string {
  const { token, claims } = issueSession(KEY, new Date());
  sessions.set(claims.id, {
    id: claims.id,
    eventToken: TOKEN,
    eventId: openEvent.eventId,
    createdAt: new Date().toISOString(),
    expiresAt: claims.expiresAt,
    ...overrides,
  });
  return token;
}

const file = { filename: 'x.jpg', contentType: 'image/jpeg', size: 10 };
function call(
  body: unknown,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): Promise<APIGatewayProxyStructuredResultV2> {
  return handler({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    headers: {
      'x-origin-verify': ORIGIN,
      ...(authorization ? { authorization } : {}),
      ...extraHeaders,
    },
    requestContext: { http: { sourceIp: '130.176.1.1' } } as never,
  });
}

describe('presign handler', () => {
  beforeEach(() => {
    vi.stubEnv('MEDIA_BUCKET', 'media-bucket');
    vi.stubEnv('SESSION_KEY_PARAM', '/p');
    vi.stubEnv('ORIGIN_VERIFY_PARAM', '/origin');
    vi.stubEnv('TABLE_NAME', 'table');
    createPresignedPost.mockResolvedValue({ url: 'https://s3.example/', fields: { key: 'k' } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    createPresignedPost.mockReset();
    sessions.clear();
    updates.length = 0;
    fullCounter = null;
    vi.mocked(gateDeps.uploadsEnabled).mockResolvedValue(true);
  });

  it('presigns for a valid session, keyed under its event and the guest', async () => {
    const res = await call({ ...file, guestName: 'Uncle Bob' }, `Bearer ${newSession()}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body ?? '');
    expect(body.key).toMatch(/^uploads\/pizza-and-games-2026\/uncle-bob\/[0-9a-f-]{36}\.jpg$/);
    expect(body.key).not.toContain(TOKEN);
    expect(createPresignedPost.mock.calls[0]?.[1]).toMatchObject({
      Bucket: 'media-bucket',
      Key: body.key,
      Expires: 600,
      Conditions: [
        ['content-length-range', 10, 10],
        ['eq', '$Content-Type', 'image/jpeg'],
      ],
    });
  });

  it('does not re-ask for the PIN (the session already proved it)', async () => {
    expect((await call(file, `Bearer ${newSession()}`)).statusCode).toBe(200);
  });

  it.each([
    [undefined, 'session-required'],
    ['Bearer v1.garbage', 'invalid-session'],
  ])('rejects auth %j with 401 %s', async (auth, error) => {
    const res = await call(file, auth);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? '').error).toBe(error);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed session whose record is gone (revoked)', async () => {
    const token = newSession();
    sessions.clear();
    expect((await call(file, `Bearer ${token}`)).statusCode).toBe(401);
  });

  it('re-checks the event: a session for an event that closed stops working', async () => {
    const token = newSession({ eventToken: 'ZZZZZZZZZZZZZZZZZZZZZZ' });
    expect((await call(file, `Bearer ${token}`)).statusCode).toBe(404);
  });

  it('honors the kill switch for existing sessions', async () => {
    const token = newSession();
    vi.mocked(gateDeps.uploadsEnabled).mockResolvedValue(false);
    expect((await call(file, `Bearer ${token}`)).statusCode).toBe(503);
  });

  it('validates the body after auth', async () => {
    const token = `Bearer ${newSession()}`;
    expect((await call('{not json', token)).statusCode).toBe(400);
    expect((await call({ ...file, contentType: 'application/zip' }, token)).statusCode).toBe(400);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'x-origin-verify': undefined as unknown as string }, 'no origin header'],
    [{ 'x-origin-verify': 'forged' }, 'wrong origin secret'],
  ])('rejects direct (non-CloudFront) calls with 403: %s', async (headers) => {
    const res = await call(file, `Bearer ${newSession()}`, headers);
    expect(res.statusCode).toBe(403);
    expect(createPresignedPost).not.toHaveBeenCalled();
    expect(reservations.length).toBe(0);
  });

  describe('quotas', () => {
    const reserved = (): Array<string | undefined> =>
      updates.filter((u) => u.ConditionExpression).map((u) => u.Key.pk.S.split('#')[0]);

    it('reserves event, IP-hour and session counters before signing', async () => {
      expect((await call(file, `Bearer ${newSession()}`)).statusCode).toBe(200);
      expect(reserved()).toEqual(['QUOTA', 'IP', 'SESSION']);
    });

    it.each([
      ['QUOTA', 'event-quota', 0],
      ['IP', 'ip-rate-limit', 1],
      ['SESSION', 'session-quota', 2],
    ])(
      'full %s counter -> 429 %s, earlier counters rolled back, nothing signed',
      async (pk, error, rollbacks) => {
        const token = `Bearer ${newSession()}`;
        fullCounter = pk;
        const res = await call(file, token);
        expect(res.statusCode).toBe(429);
        expect(JSON.parse(res.body ?? '').error).toBe(error);
        expect(updates.filter((u) => !u.ConditionExpression)).toHaveLength(rollbacks);
        expect(createPresignedPost).not.toHaveBeenCalled();
      },
    );

    it('counts each viewer IP separately (via CloudFront)', async () => {
      const token = `Bearer ${newSession()}`;
      const ipPk = (): string =>
        updates.filter((u) => u.Key.pk.S.startsWith('IP#')).at(-1)!.Key.pk.S;
      await call(file, token, { 'x-viewer-ip': '198.51.100.1' });
      const first = ipPk();
      await call(file, token, { 'x-viewer-ip': '198.51.100.2' });
      expect(ipPk()).not.toBe(first);
      await call(file, token, { 'x-viewer-ip': '198.51.100.1' });
      expect(ipPk()).toBe(first);
    });

    it('refuses an oversized file at validation, before any counter write', async () => {
      const res = await call({ ...file, size: 11 * 1024 ** 3 }, `Bearer ${newSession()}`);
      expect(res.statusCode).toBe(400);
      expect(reservations.length).toBe(0);
    });
  });
});
