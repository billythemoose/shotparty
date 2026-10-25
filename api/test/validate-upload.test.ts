import { readFileSync } from 'node:fs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { err, ok } from '../src/lib/result.js';
import {
  acceptedKey,
  md5FromEtag,
  type UploadedObject,
  type ValidateDeps,
  validateUpload,
} from '../src/lib/validate-upload.js';

const MD5 = '0123456789abcdef0123456789abcdef';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

interface FakeDeps extends ValidateDeps {
  readHead: Mock<ValidateDeps['readHead']>;
  claimContent: Mock<ValidateDeps['claimContent']>;
  copy: Mock<ValidateDeps['copy']>;
  deleteVersion: Mock<ValidateDeps['deleteVersion']>;
  recordRejection: Mock<ValidateDeps['recordRejection']>;
  log: Mock<ValidateDeps['log']>;
}

function fakeDeps(bytes: Uint8Array | null, etag = `"${MD5}"`): FakeDeps {
  return {
    readHead: vi.fn<ValidateDeps['readHead']>().mockResolvedValue(bytes && { bytes, etag }),
    claimContent: vi.fn<ValidateDeps['claimContent']>().mockResolvedValue(ok(undefined)),
    copy: vi.fn<ValidateDeps['copy']>().mockResolvedValue(),
    deleteVersion: vi.fn<ValidateDeps['deleteVersion']>().mockResolvedValue(),
    recordRejection: vi.fn<ValidateDeps['recordRejection']>().mockResolvedValue(),
    log: vi.fn<ValidateDeps['log']>(),
    now: () => new Date('2026-09-25T12:00:00Z'),
  } satisfies ValidateDeps;
}

const obj: UploadedObject = {
  bucket: 'media',
  key: 'uploads/evt1/aunt-may/abc.jpg',
  versionId: 'v1',
  size: 1234,
};

describe('acceptedKey', () => {
  it('moves uploads/<...> to accepted/<...>', () => {
    expect(acceptedKey('uploads/evt1/aunt-may/abc.jpg')).toBe('accepted/evt1/aunt-may/abc.jpg');
  });
});

describe('md5FromEtag', () => {
  it('reads a single-part ETag, quoted or not', () => {
    expect(md5FromEtag(`"${MD5.toUpperCase()}"`)).toBe(MD5);
    expect(md5FromEtag(MD5)).toBe(MD5);
  });

  it.each([`"${MD5}-3"`, '', '"abc"'])('returns null for %j', (etag) => {
    expect(md5FromEtag(etag)).toBeNull();
  });
});

describe('validateUpload', () => {
  it('copies real media to accepted/ then deletes that exact upload version', async () => {
    const deps = fakeDeps(fixture('photo.heic'));
    await expect(validateUpload(obj, deps)).resolves.toEqual({
      result: 'accepted',
      kind: 'heif',
      destKey: 'accepted/evt1/aunt-may/abc.jpg',
    });
    expect(deps.readHead).toHaveBeenCalledWith(obj, 64);
    expect(deps.copy).toHaveBeenCalledWith(obj, 'accepted/evt1/aunt-may/abc.jpg');
    expect(deps.deleteVersion).toHaveBeenCalledWith(obj);
    // Copy must finish before the original is removed.
    expect(deps.copy.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deleteVersion.mock.invocationCallOrder[0]!,
    );
    expect(deps.recordRejection).not.toHaveBeenCalled();
  });

  it('deletes and records non-media without copying it', async () => {
    const deps = fakeDeps(fixture('zip-renamed.jpg'));
    await expect(validateUpload(obj, deps)).resolves.toEqual({
      result: 'rejected',
      reason: 'bad-magic',
    });
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.deleteVersion).toHaveBeenCalledWith(obj);
    expect(deps.recordRejection).toHaveBeenCalledWith({
      eventId: 'evt1',
      guest: 'aunt-may',
      key: obj.key,
      size: 1234,
      reason: 'bad-magic',
      headHex: '504b0304140000000800000000000000',
      at: '2026-09-25T12:00:00.000Z',
    });
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'rejected', reason: 'bad-magic' }),
    );
  });

  it('is a no-op when the object is already gone (duplicate delivery)', async () => {
    const deps = fakeDeps(null);
    await expect(validateUpload(obj, deps)).resolves.toEqual({
      result: 'skipped',
      reason: 'already-processed',
    });
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.deleteVersion).not.toHaveBeenCalled();
  });

  it('ignores objects outside uploads/ (never touches accepted/)', async () => {
    const deps = fakeDeps(fixture('photo.jpg'));
    await expect(
      validateUpload({ ...obj, key: 'accepted/evt1/x/abc.jpg' }, deps),
    ).resolves.toMatchObject({ result: 'skipped', reason: 'not-an-upload' });
    expect(deps.readHead).not.toHaveBeenCalled();
  });

  it('keeps the original if the copy fails (so a retry can succeed)', async () => {
    const deps = fakeDeps(fixture('photo.jpg'));
    deps.copy.mockRejectedValue(new Error('throttled'));
    await expect(validateUpload(obj, deps)).rejects.toThrow('throttled');
    expect(deps.deleteVersion).not.toHaveBeenCalled();
  });
});

describe('validateUpload duplicates', () => {
  it('claims the content for the guest before copying', async () => {
    const deps = fakeDeps(fixture('photo.jpg'));
    await expect(validateUpload(obj, deps)).resolves.toMatchObject({ result: 'accepted' });
    expect(deps.claimContent).toHaveBeenCalledWith({
      eventId: 'evt1',
      guest: 'aunt-may',
      md5: MD5,
      destKey: 'accepted/evt1/aunt-may/abc.jpg',
      at: '2026-09-25T12:00:00.000Z',
    });
    expect(deps.claimContent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.copy.mock.invocationCallOrder[0]!,
    );
  });

  it('drops a repeat of a file the guest already uploaded', async () => {
    const deps = fakeDeps(fixture('photo.jpg'));
    const existingKey = 'accepted/evt1/aunt-may/first.jpg';
    deps.claimContent.mockResolvedValue(err({ kind: 'duplicate', existingKey }));
    await expect(validateUpload(obj, deps)).resolves.toEqual({
      result: 'duplicate',
      duplicateOf: existingKey,
    });
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.deleteVersion).toHaveBeenCalledWith(obj);
    expect(deps.recordRejection).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'duplicate', duplicateOf: existingKey }),
    );
  });

  it('accepts without a claim when the ETag is not an MD5 (multipart)', async () => {
    const deps = fakeDeps(fixture('photo.jpg'), `"${MD5}-2"`);
    await expect(validateUpload(obj, deps)).resolves.toMatchObject({ result: 'accepted' });
    expect(deps.claimContent).not.toHaveBeenCalled();
    expect(deps.copy).toHaveBeenCalled();
  });

  it('never claims content for non-media', async () => {
    const deps = fakeDeps(fixture('zip-renamed.jpg'));
    await expect(validateUpload(obj, deps)).resolves.toMatchObject({ result: 'rejected' });
    expect(deps.claimContent).not.toHaveBeenCalled();
  });
});
