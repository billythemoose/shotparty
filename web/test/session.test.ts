import { describe, expect, it, type Mock, vi } from 'vitest';
import { err, ok, type Result } from '../src/result';
import { SessionManager, type SessionStorage } from '../src/session';
import type { VerificationFailure } from '../src/turnstile';
import type { createSession, SessionGrant } from '../src/upload';

interface MemoryStorage extends SessionStorage {
  value: SessionGrant | null;
}

function memoryStorage(initial: SessionGrant | null = null): MemoryStorage {
  const s: MemoryStorage = {
    value: initial,
    load: () => s.value,
    save: (g) => {
      s.value = g;
    },
  };
  return s;
}

const NOW = 1_800_000_000_000; // ms

function grant(session: string, expiresInSeconds: number): SessionGrant {
  return { session, expiresAt: NOW / 1000 + expiresInSeconds };
}

type Create = Mock<typeof createSession>;

interface Harness {
  m: SessionManager;
  create: Create;
  getTurnstileToken: Mock<() => Promise<Result<string, VerificationFailure>>>;
}

function manager(
  storage: SessionStorage,
  create: Create = vi.fn<typeof createSession>(async () => ok(grant('new', 12 * 3600))),
): Harness {
  const getTurnstileToken = vi.fn(async () => ok('tt'));
  const m = new SessionManager({
    eventToken: 'tok',
    getPin: () => '482913',
    getTurnstileToken,
    storage,
    now: () => NOW,
    create,
  });
  return { m, create, getTurnstileToken };
}

describe('SessionManager', () => {
  it('reuses a stored session that is not close to expiry', async () => {
    const { m, create } = manager(memoryStorage(grant('stored', 3600)));
    await expect(m.ensure()).resolves.toEqual(ok('stored'));
    expect(create).not.toHaveBeenCalled();
  });

  it('renews a session within 5 minutes of expiry', async () => {
    const storage = memoryStorage(grant('old', 4 * 60));
    const { m, create } = manager(storage);
    await expect(m.ensure()).resolves.toEqual(ok('new'));
    expect(create).toHaveBeenCalledWith({ eventToken: 'tok', pin: '482913', turnstileToken: 'tt' });
    expect(storage.value?.session).toBe('new');
  });

  it('shares one request between concurrent uploads (one Turnstile solve)', async () => {
    const { m, create, getTurnstileToken } = manager(memoryStorage());
    const results = await Promise.all([m.ensure(), m.ensure(), m.ensure()]);
    expect(results).toEqual([ok('new'), ok('new'), ok('new')]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(getTurnstileToken).toHaveBeenCalledTimes(1);
  });

  it('clear() forces a new session next time', async () => {
    const storage = memoryStorage(grant('stored', 3600));
    const { m } = manager(storage);
    m.clear();
    await expect(m.ensure()).resolves.toEqual(ok('new'));
  });

  it('a failed attempt does not stick: the next call tries again', async () => {
    const wrongPin = err({ kind: 'api-refused', status: 403, code: 'wrong-pin' } as const);
    const create = vi
      .fn<typeof createSession>()
      .mockResolvedValueOnce(wrongPin)
      .mockResolvedValueOnce(ok(grant('second', 3600)));
    const storage = memoryStorage();
    const { m } = manager(storage, create);
    await expect(m.ensure()).resolves.toEqual(wrongPin);
    expect(storage.value).toBeNull();
    await expect(m.ensure()).resolves.toEqual(ok('second'));
  });

  it('passes on a Turnstile failure without asking the API', async () => {
    const { m, create, getTurnstileToken } = manager(memoryStorage());
    const blocked = err({ kind: 'verification-unavailable', message: 'blocked' } as const);
    getTurnstileToken.mockResolvedValueOnce(blocked);
    await expect(m.ensure()).resolves.toEqual(blocked);
    expect(create).not.toHaveBeenCalled();
  });
});
