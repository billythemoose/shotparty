import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprint, loadUploaded, rememberUploaded, uploadedEntry } from '../src/uploaded';

const MIB = 1024 ** 2;

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function blobOf(size: number, fill: number): Blob {
  return new Blob([new Uint8Array(size).fill(fill)]);
}

describe('fingerprint', () => {
  it('is the same for the same bytes and includes the size', async () => {
    const print = await fingerprint(blobOf(1000, 7));
    expect(print).toMatch(/^1000:[0-9a-f]{64}$/);
    expect(await fingerprint(blobOf(1000, 7))).toBe(print);
  });

  it('differs when the content or the size differs', async () => {
    const print = await fingerprint(blobOf(1000, 7));
    expect(await fingerprint(blobOf(1000, 8))).not.toBe(print);
    expect(await fingerprint(blobOf(1001, 7))).not.toBe(print);
  });

  it('reads only the first and last MiB of a large file', async () => {
    const size = 3 * MIB;
    const a = new Uint8Array(size);
    const b = new Uint8Array(size);
    b[Math.floor(size / 2)] = 1; // differs only in the unread middle
    expect(await fingerprint(new Blob([a]))).toBe(await fingerprint(new Blob([b])));
    b[size - 1] = 1; // and now in the last MiB
    expect(await fingerprint(new Blob([a]))).not.toBe(await fingerprint(new Blob([b])));
  });
});

describe('uploadedEntry', () => {
  it('ties the fingerprint to the guest name, ignoring case and spaces', () => {
    expect(uploadedEntry(' Aunt May ', 'p')).toBe(uploadedEntry('aunt may', 'p'));
    expect(uploadedEntry('Aunt May', 'p')).not.toBe(uploadedEntry('Uncle Ben', 'p'));
  });
});

describe('remembered uploads', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers entries per event', () => {
    rememberUploaded('evt1', 'a');
    rememberUploaded('evt1', 'b');
    rememberUploaded('evt1', 'a');
    expect(loadUploaded('evt1')).toEqual(new Set(['a', 'b']));
    expect(loadUploaded('evt2')).toEqual(new Set());
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('shotparty.uploaded.evt1', '{"not":"a list"}');
    expect(loadUploaded('evt1')).toEqual(new Set());
    rememberUploaded('evt1', 'a');
    expect(loadUploaded('evt1')).toEqual(new Set(['a']));
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => {
      rememberUploaded('evt1', 'a');
    }).not.toThrow();
    expect(loadUploaded('evt1')).toEqual(new Set());
  });
});
