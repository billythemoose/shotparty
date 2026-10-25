import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { qrPng, qrSvg, writeQrFiles } from '../lib/qr.js';

const GUEST_URL = 'https://d111111abcdef8.cloudfront.net/e/AbCdEfGhIjKlMnOpQrStUv';

function decodePng(buf: Buffer): string | undefined {
  const png = PNG.sync.read(buf);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
}

describe('QR generation', () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true }))));

  it('PNG decodes back to exactly the URL', async () => {
    expect(decodePng(await qrPng(GUEST_URL))).toBe(GUEST_URL);
  });

  it('PNG is print-sized', async () => {
    expect(PNG.sync.read(await qrPng(GUEST_URL)).width).toBe(1200);
  });

  it('SVG is a standalone vector image', async () => {
    const svg = await qrSvg(GUEST_URL);
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('<path');
  });

  it('writes both files, and the written PNG still decodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shotparty-qr-'));
    dirs.push(dir);
    const [svgPath, pngPath] = await writeQrFiles(GUEST_URL, dir, 'pizza-and-games-2026-dev');
    expect(svgPath).toMatch(/pizza-and-games-2026-dev\.svg$/);
    expect(decodePng(await readFile(pngPath!))).toBe(GUEST_URL);
  });
});
