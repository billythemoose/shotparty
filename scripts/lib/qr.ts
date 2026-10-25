/**
 * @fileoverview QR codes for event links, generated locally: the URL contains the secret event
 * token, so it must never be pasted into an online QR generator.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';

// Level Q restores ~25% damage: survives smudges, creases, and a logo-free center on printed cards.
const OPTIONS = { errorCorrectionLevel: 'Q', margin: 4 } as const;

/** Returns the QR code as SVG text. */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { ...OPTIONS, type: 'svg' });
}

/** 1200 px wide: ~4 in / 10 cm at 300 dpi, plenty for printed cards. */
export async function qrPng(url: string, width = 1200): Promise<Buffer> {
  return QRCode.toBuffer(url, { ...OPTIONS, type: 'png', width });
}

/** Writes <dir>/<baseName>.svg and .png; returns their paths. */
export async function writeQrFiles(url: string, dir: string, baseName: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const svgPath = join(dir, `${baseName}.svg`);
  const pngPath = join(dir, `${baseName}.png`);
  await writeFile(svgPath, await qrSvg(url));
  await writeFile(pngPath, await qrPng(url));
  return [svgPath, pngPath];
}
