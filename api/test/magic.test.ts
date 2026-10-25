import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sniffMedia } from '../src/lib/magic.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe('sniffMedia', () => {
  it.each([
    ['photo.jpg', 'jpeg'],
    ['photo.png', 'png'],
    ['photo.gif', 'gif'],
    ['photo.webp', 'webp'],
    ['photo.heic', 'heif'],
    ['heif-generic.heif', 'heif'],
    ['iphone.mov', 'quicktime'],
    ['legacy.mov', 'quicktime'],
    ['android.mp4', 'mp4'],
    ['generic.mp4', 'mp4'],
    ['phone.3gp', '3gp'],
    ['clip.webm', 'webm'],
    ['photo.dng', 'tiff'],
    ['photo.cr2', 'tiff'],
    ['photo.nef', 'tiff'],
    ['photo.arw', 'tiff'],
    ['photo.orf', 'orf'],
    ['photo.rw2', 'rw2'],
    ['photo.raf', 'raf'],
    ['photo.cr3', 'cr3'],
  ])('recognizes %s as %s', (name, kind) => {
    expect(sniffMedia(fixture(name))).toBe(kind);
  });

  it.each([
    'zip-renamed.jpg',
    'text-renamed.jpg',
    'html-renamed.jpg',
    'pdf-renamed.jpg',
    'exe-renamed.jpg',
    'svg-renamed.jpg',
    'audio-m4a.mp4',
    'avif.jpg',
    'text-renamed.dng',
    'bigtiff.dng',
  ])('rejects %s', (name) => {
    expect(sniffMedia(fixture(name))).toBeNull();
  });

  it('rejects empty and truncated input', () => {
    expect(sniffMedia(new Uint8Array())).toBeNull();
    expect(sniffMedia(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffMedia(fixture('iphone.mov').subarray(0, 10))).toBeNull();
    expect(sniffMedia(fixture('photo.dng').subarray(0, 3))).toBeNull();
    expect(sniffMedia(fixture('photo.raf').subarray(0, 14))).toBeNull();
  });

  it('rejects other ISO-BMFF brands next to CR3 (the brand decides, not the extension)', () => {
    const notCr3 = fixture('photo.cr3').slice();
    notCr3.set(new TextEncoder().encode('crw '), 8);
    expect(sniffMedia(notCr3)).toBeNull();
  });

  it('rejects Matroska (EBML without the webm doctype)', () => {
    const mkv = fixture('clip.webm').slice();
    mkv.set(new TextEncoder().encode('mkvx'), mkv.indexOf(0x77)); // overwrite "webm"
    expect(sniffMedia(mkv)).toBeNull();
  });
});
