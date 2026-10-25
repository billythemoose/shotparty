import { describe, expect, it } from 'vitest';
import { manifestCsv, planDownload, verifyFile } from '../lib/download.js';

const objects = [
  {
    key: 'accepted/ev/frank/1e856bfb-0f5e-4591.jpg',
    size: 10,
    etag: '"0123456789abcdef0123456789abcdef"',
    lastModified: new Date('2026-10-10T20:05:09Z'),
  },
  {
    key: 'accepted/ev/anonymous/55828201-243d.mp4',
    size: 20,
    etag: '"d41d8cd98f00b204e9800998ecf8427e-3"', // multipart: not an MD5
    lastModified: new Date('2026-10-10T20:06:00Z'),
  },
  {
    key: 'accepted/unassigned/aaaaaaaa-1.jpg', // pre-guest-folder key
    size: 5,
    etag: 'ffffffffffffffffffffffffffffffff',
    lastModified: new Date('2026-10-10T20:07:00Z'),
  },
];

describe('planDownload', () => {
  const plan = planDownload(objects);

  it('files each object under its guest with a readable, sortable name', () => {
    expect(plan.map((p) => p.relativePath)).toEqual([
      'frank/frank_2026-10-10_20-05-09_1e856bfb.jpg',
      'anonymous/anonymous_2026-10-10_20-06-00_55828201.mp4',
      'unknown/unknown_2026-10-10_20-07-00_aaaaaaaa.jpg',
    ]);
  });

  it('uses the ETag as MD5 only when it is one (not multipart)', () => {
    expect(plan.map((p) => p.md5)).toEqual([
      '0123456789abcdef0123456789abcdef',
      null,
      'ffffffffffffffffffffffffffffffff',
    ]);
  });

  it('gives every file a unique path', () => {
    expect(new Set(plan.map((p) => p.relativePath)).size).toBe(plan.length);
  });
});

describe('manifestCsv', () => {
  it('has a header and one row per file, quoting where needed', () => {
    const csv = manifestCsv(planDownload(objects));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('file,guest,uploaded_utc,bytes,md5,s3_key');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      'frank/frank_2026-10-10_20-05-09_1e856bfb.jpg,frank,2026-10-10T20:05:09.000Z,10,0123456789abcdef0123456789abcdef,accepted/ev/frank/1e856bfb-0f5e-4591.jpg',
    );
  });
});

describe('verifyFile', () => {
  const planned = { size: 10, md5: 'aaaa' };
  it.each([
    [null, 'missing'],
    [{ size: 9, md5: 'aaaa' }, 'size-mismatch'],
    [{ size: 10, md5: 'bbbb' }, 'md5-mismatch'],
    [{ size: 10, md5: 'aaaa' }, 'ok'],
  ])('%j -> %s', (local, verdict) => {
    expect(verifyFile(planned, local)).toBe(verdict);
  });

  it('checks size only when there is no MD5 (multipart)', () => {
    expect(verifyFile({ size: 10, md5: null }, { size: 10, md5: 'whatever' })).toBe('ok');
  });
});
