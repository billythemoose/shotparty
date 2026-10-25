import { describe, expect, it } from 'vitest';
import {
  downloadName,
  escapeHtml,
  type GalleryItem,
  groupByGuest,
  guestOf,
  kindOf,
  renderGallery,
} from '../lib/gallery.js';

function item(key: string, uploadedAt: string, size = 1000): GalleryItem {
  return {
    key,
    guest: guestOf(key),
    size,
    uploadedAt: new Date(uploadedAt),
    viewUrl: `https://s3.example/${key}?X-Amz-Signature=abc&x=1`,
    downloadUrl: `https://s3.example/${key}?dl=1`,
  };
}

const items = [
  item('accepted/ev/frank/aaaaaaaa-1.jpg', '2026-10-10T20:05:00Z', 3_000_000),
  item('accepted/ev/frank/bbbbbbbb-2.mov', '2026-10-10T20:01:00Z', 6_000_000),
  item('accepted/ev/anonymous/cccccccc-3.heic', '2026-10-10T20:02:00Z'),
  item('accepted/ev/zoe/dddddddd-4.png', '2026-10-10T20:03:00Z'),
];
const meta = {
  eventId: 'ev',
  stage: 'dev',
  generatedAt: new Date('2026-10-10T21:00:00Z'),
  linksExpireAt: new Date('2026-10-11T03:00:00Z'),
};

describe('gallery helpers', () => {
  it.each([
    ['a/b/c/x.JPG', 'image'],
    ['a/b/c/x.heic', 'heic'],
    ['a/b/c/x.mov', 'video'],
    ['a/b/c/x.3gp', 'video'],
    ['a/b/c/x.DNG', 'raw'],
    ['a/b/c/x.cr3', 'raw'],
    ['a/b/c/x.bin', 'other'],
  ])('kindOf %s -> %s', (key, kind) => {
    expect(kindOf(key)).toBe(kind);
  });

  it('reads the guest folder, tolerating pre-guest-folder keys', () => {
    expect(guestOf('accepted/ev/frank/x.jpg')).toBe('frank');
    expect(guestOf('accepted/unassigned/x.jpg')).toBe('');
  });

  it('makes sortable, readable download names', () => {
    expect(
      downloadName({
        key: 'accepted/ev/frank/1e856bfb-0f5e.jpg',
        guest: 'frank',
        uploadedAt: new Date('2026-10-10T20:05:09Z'),
      }),
    ).toBe('frank_2026-10-10_20-05-09_1e856bfb.jpg');
  });

  it('groups by guest: most files first, anonymous last, each group oldest first', () => {
    const groups = groupByGuest(items);
    expect(groups.map(([g]) => g)).toEqual(['frank', 'zoe', 'anonymous']);
    expect(groups[0]![1].map((i) => i.key.split('/').pop())).toEqual([
      'bbbbbbbb-2.mov',
      'aaaaaaaa-1.jpg',
    ]);
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });
});

describe('renderGallery', () => {
  const html = renderGallery(items, meta, (d) => d.toISOString());

  it('summarizes the event', () => {
    expect(html).toContain('<title>Gallery: ev (dev)</title>');
    expect(html).toContain('4 files · 8.6 MB · 3 guest folders');
  });

  it('renders images as zoomable lazy thumbnails, videos as players, HEIC with a fallback', () => {
    expect(html).toContain(
      'class="thumb" data-full="https://s3.example/accepted/ev/frank/aaaaaaaa-1.jpg',
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/<video src="[^"]+bbbbbbbb-2\.mov[^"]*" controls preload="metadata"/);
    expect(html).toContain('HEIC photo: preview in Safari, or download');
  });

  it('shows RAW photos as a labeled tile with a download link (browsers cannot render RAW)', () => {
    const raw = { ...items[0]!, key: 'accepted/ev/frank/cccccccc-3.cr3' };
    const page = renderGallery([raw], meta);
    expect(page).toContain('<span class="placeholder">CR3 RAW photo: download to view</span>');
    expect(page).not.toContain('<img src');
    expect(page).toContain('>Download</a>');
  });

  it('escapes signed URLs in attributes (& becomes &amp;)', () => {
    expect(html).toContain('X-Amz-Signature=abc&amp;x=1');
    expect(html).not.toContain('X-Amz-Signature=abc&x=1');
  });

  it('keeps pages private-ish: noindex and no referrer leaking signed URLs', () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('handles an empty event', () => {
    expect(renderGallery([], meta)).toContain('No accepted uploads yet.');
  });
});
