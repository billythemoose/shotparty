/**
 * @fileoverview Identifies uploaded media from its first bytes (file signatures), independent of
 * the declared Content-Type or extension. Anything unrecognized is rejected by the validate handler.
 */

/** How many leading bytes {@link sniffMedia} needs. */
export const SNIFF_BYTES = 64;

/**
 * The media types the validator accepts. RAW photos are `tiff` (DNG, CR2, NEF, ARW, and plain
 * TIFF), `orf`, `rw2`, `raf` or `cr3`.
 */
export type MediaKind =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'heif'
  | 'mp4'
  | '3gp'
  | 'quicktime'
  | 'webm'
  | 'tiff'
  | 'orf'
  | 'rw2'
  | 'raf'
  | 'cr3';

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return (
    bytes.length >= offset + signature.length && signature.every((v, i) => bytes[offset + i] === v)
  );
}

// ISO-BMFF ("ftyp" box) major brands. Decided by the MAJOR brand: AVIF files also list "mif1"
// as a compatible brand, so compatible-brand matching alone would admit them.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1']);
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'M4VP',
  'mmp4',
  'dash',
  'MSNV',
  'NDAS',
]);
const THREE_GP_PREFIXES = ['3gp', '3g2', '3ge', '3gg', '3gs'];
// Legacy QuickTime files may start with one of these atoms instead of "ftyp".
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function sniffIsoBmff(bytes: Uint8Array): MediaKind | null {
  if (bytes.length < 12) return null;
  const boxType = ascii(bytes, 4, 8);
  if (QUICKTIME_ATOMS.has(boxType)) return 'quicktime';
  if (boxType !== 'ftyp') return null;

  const major = ascii(bytes, 8, 12);
  if (major === 'qt  ') return 'quicktime';
  if (HEIF_BRANDS.has(major)) return 'heif';
  if (MP4_BRANDS.has(major)) return 'mp4';
  if (THREE_GP_PREFIXES.some((p) => major.startsWith(p))) return '3gp';
  if (major === 'crx ') return 'cr3'; // Canon CR3 RAW
  if (GENERIC_HEIF_BRANDS.has(major)) {
    // Generic HEIF container: accept only if it declares a HEIC/HEVC image brand.
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const end = Math.min(boxSize, bytes.length);
    for (let i = 16; i + 4 <= end; i += 4) {
      if (HEIF_BRANDS.has(ascii(bytes, i, i + 4))) return 'heif';
    }
  }
  return null; // e.g. "M4A " (audio), "avif", unknown brands
}

// TIFF-based RAW. DNG, CR2, NEF and ARW are plain TIFF headers (so plain TIFF passes too, which is
// harmless); Olympus and Panasonic change the TIFF magic number.
function sniffTiff(bytes: Uint8Array): MediaKind | null {
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  if (bytes.length >= 4 && ['IIRO', 'IIRS', 'MMOR'].includes(ascii(bytes, 0, 4))) return 'orf';
  if (startsWith(bytes, [0x49, 0x49, 0x55, 0x00])) return 'rw2';
  return null;
}

/** Returns what the bytes are, judged by their file signature, or null if not accepted media. */
export function sniffMedia(bytes: Uint8Array): MediaKind | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML container; require the "webm" DocType (Matroska .mkv isn't on the allow-list).
    return ascii(bytes, 0, bytes.length).includes('webm') ? 'webm' : null;
  }
  if (bytes.length >= 15 && ascii(bytes, 0, 15) === 'FUJIFILMCCD-RAW') return 'raf';
  return sniffTiff(bytes) ?? sniffIsoBmff(bytes);
}
