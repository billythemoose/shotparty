import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickerAccept, RAW_EXTENSIONS, resolveContentType } from '../src/mime';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('resolveContentType', () => {
  it.each([
    [{ name: 'IMG_1.JPG', type: 'image/jpeg' }, 'image/jpeg'],
    [{ name: 'clip.MOV', type: 'video/quicktime' }, 'video/quicktime'],
    [{ name: 'IMG_2.HEIC', type: '' }, 'image/heic'],
    [{ name: 'IMG_3.heif', type: 'application/octet-stream' }, 'image/heif'],
    [{ name: 'VID.m4v', type: '' }, 'video/mp4'],
  ])('%j -> %s', (file, expected) => {
    expect(resolveContentType(file)).toBe(expected);
  });

  it.each([
    [{ name: 'IMG_4.DNG', type: '' }, 'image/x-adobe-dng'],
    [{ name: 'IMG_5.dng', type: 'image/x-adobe-dng' }, 'image/x-adobe-dng'],
    [{ name: 'IMG_6.dng', type: 'image/dng' }, 'image/x-adobe-dng'],
    [{ name: 'IMG_7.dng', type: 'image/tiff' }, 'image/x-adobe-dng'],
    [{ name: '_MG_8.CR2', type: 'image/x-canon-cr2' }, 'image/x-canon-cr2'],
    [{ name: '_MG_9.CR3', type: '' }, 'image/x-canon-cr3'],
    [{ name: 'DSC_1.NEF', type: 'application/octet-stream' }, 'image/x-nikon-nef'],
    [{ name: 'DSC_2.ARW', type: 'image/x-sony-arw' }, 'image/x-sony-arw'],
    [{ name: 'DSCF3.RAF', type: 'image/x-fujifilm-raf' }, 'image/x-fuji-raf'],
    [{ name: 'P4.ORF', type: '' }, 'image/x-olympus-orf'],
    [{ name: 'P5.RW2', type: 'image/x-panasonic-raw' }, 'image/x-panasonic-rw2'],
  ])('RAW %j -> %s', (file, expected) => {
    expect(resolveContentType(file)).toBe(expected);
  });

  it.each([
    { name: 'drawing.svg', type: 'image/svg+xml' },
    { name: 'notes.pdf', type: 'application/pdf' },
    { name: 'archive.zip', type: '' },
    { name: 'noextension', type: '' },
    // A declared non-media type wins over a misleading extension.
    { name: 'fake.jpg', type: 'text/html' },
    { name: 'fake.dng', type: 'text/html' },
    // A RAW alias type only counts with a RAW extension.
    { name: 'scan.tiff', type: 'image/tiff' },
    { name: 'scan.jpg', type: 'image/x-raw' },
  ])('rejects %j', (file) => {
    expect(resolveContentType(file)).toBeNull();
  });
});

describe('pickerAccept', () => {
  it('offers media types only on Android, so Chrome opens the photo picker', () => {
    expect(pickerAccept(ANDROID_CHROME)).toBe('image/*,video/*');
  });

  it.each([IPHONE_SAFARI, MAC_CHROME])('offers every RAW extension elsewhere: %s', (ua) => {
    expect(pickerAccept(ua).split(',')).toEqual(['image/*', 'video/*', ...RAW_EXTENSIONS]);
  });
});

describe('the file input', () => {
  it('starts with the non-Android list, so the page picks RAW before the script runs', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const accept = /id="files"[^>]*accept="([^"]*)"/.exec(html)?.[1];
    expect(accept).toBe(pickerAccept(MAC_CHROME));
  });
});
