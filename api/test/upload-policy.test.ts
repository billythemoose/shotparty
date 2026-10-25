import { describe, expect, it } from 'vitest';
import {
  guestSlug,
  MAX_UPLOAD_BYTES,
  objectKey,
  postConditions,
  validateUploadRequest,
} from '../src/lib/upload-policy.js';

describe('validateUploadRequest', () => {
  const good = { filename: 'IMG_0001.HEIC', contentType: 'image/heic', size: 3_000_000 };

  it('accepts a normal photo and normalizes content type case', () => {
    expect(validateUploadRequest({ ...good, contentType: 'IMAGE/HEIC' })).toEqual({
      ok: true,
      value: { ...good, contentType: 'image/heic', guestSlug: 'anonymous' },
    });
  });

  it('slugifies an optional guest name', () => {
    const result = validateUploadRequest({ ...good, guestName: 'Aunt May' });
    expect(result.ok && result.value.guestSlug).toBe('aunt-may');
  });

  it.each(['video/quicktime', 'video/mp4', 'image/jpeg', 'image/png'])('accepts %s', (ct) => {
    expect(validateUploadRequest({ ...good, contentType: ct }).ok).toBe(true);
  });

  it.each([
    ['missing filename', { ...good, filename: undefined }],
    ['empty filename', { ...good, filename: '' }],
    ['overlong filename', { ...good, filename: 'a'.repeat(256) }],
    ['zip', { ...good, contentType: 'application/zip' }],
    ['svg (scriptable image)', { ...good, contentType: 'image/svg+xml' }],
    ['html', { ...good, contentType: 'text/html' }],
    ['zero bytes', { ...good, size: 0 }],
    ['fractional size', { ...good, size: 1.5 }],
    ['size as string', { ...good, size: '100' }],
    ['over 1 GiB', { ...good, size: MAX_UPLOAD_BYTES + 1 }],
    ['non-string guest name', { ...good, guestName: 42 }],
    ['overlong guest name', { ...good, guestName: 'x'.repeat(81) }],
  ])('rejects %s', (_label, body: Record<string, unknown>) => {
    expect(validateUploadRequest(body).ok).toBe(false);
  });

  it('accepts exactly the max size', () => {
    expect(validateUploadRequest({ ...good, size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });

  it('applies a configured max size instead of the default', () => {
    expect(
      validateUploadRequest({ ...good, size: 2 * MAX_UPLOAD_BYTES }, 2 * MAX_UPLOAD_BYTES).ok,
    ).toBe(true);
    expect(validateUploadRequest({ ...good, size: 1001 }, 1000)).toEqual({
      ok: false,
      error: { kind: 'invalid-request', message: 'size must be an integer from 1 to 1000 bytes' },
    });
  });

  it.each(['image/tiff', 'image/x-canon-crw', 'image/x-raw'])(
    'rejects RAW-like types off the list: %s',
    (ct) => {
      expect(validateUploadRequest({ ...good, contentType: ct }).ok).toBe(false);
    },
  );
});

describe('objectKey for RAW', () => {
  it.each([
    ['image/x-adobe-dng', 'dng'],
    ['image/x-canon-cr2', 'cr2'],
    ['image/x-canon-cr3', 'cr3'],
    ['image/x-nikon-nef', 'nef'],
    ['image/x-sony-arw', 'arw'],
    ['image/x-fuji-raf', 'raf'],
    ['image/x-olympus-orf', 'orf'],
    ['image/x-panasonic-rw2', 'rw2'],
  ])('stores %s as .%s', (ct, ext) => {
    expect(validateUploadRequest({ filename: `x.${ext}`, contentType: ct, size: 1 }).ok).toBe(true);
    expect(objectKey('evt1', 'sam', 'abc', ct)).toBe(`uploads/evt1/sam/abc.${ext}`);
  });
});

describe('objectKey', () => {
  it('uses event and guest folders, the id, and an extension from the content type', () => {
    expect(objectKey('evt1', 'aunt-may', 'abc', 'video/quicktime')).toBe(
      'uploads/evt1/aunt-may/abc.mov',
    );
  });

  it('refuses unknown content types', () => {
    expect(() => objectKey('evt1', 'anonymous', 'abc', 'application/zip')).toThrow();
  });
});

describe('guestSlug', () => {
  it.each([
    ['Aunt May', 'aunt-may'],
    ["Zoë O'Brien", 'zoe-o-brien'],
    ['  --José--  ', 'jose'],
    ['../../etc/passwd', 'etc-passwd'],
    ['a/b\\c', 'a-b-c'],
    ['🎉🎉', 'anonymous'],
    ['', 'anonymous'],
    [undefined, 'anonymous'],
    [42, 'anonymous'],
  ])('%j -> %s', (input, expected) => {
    expect(guestSlug(input)).toBe(expected);
  });

  it('caps length at 40 without a trailing dash', () => {
    const slug = guestSlug('a'.repeat(39) + ' bcdef');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('postConditions', () => {
  it('pins the byte range to the declared size and the exact content type', () => {
    expect(
      postConditions({ filename: 'a.jpg', contentType: 'image/jpeg', size: 42, guestSlug: 'x' }),
    ).toEqual([
      ['content-length-range', 42, 42],
      ['eq', '$Content-Type', 'image/jpeg'],
    ]);
  });
});
