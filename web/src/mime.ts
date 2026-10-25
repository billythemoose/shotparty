/**
 * @fileoverview Some mobile browsers report an empty File.type (notably for HEIC/HEIF on Android),
 * and browsers report RAW photos as empty, `application/octet-stream` or a vendor type, so fall
 * back to the extension. Must stay in sync with the API allow-list
 * (api/src/lib/upload-policy.ts).
 */

// Camera RAW formats, with the one content type the API accepts for each.
const RAW_BY_EXTENSION: Record<string, string> = {
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw',
  raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
};

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  ...RAW_BY_EXTENSION,
};

/** Every RAW extension with its dot, as the file input's `accept` list must name them. */
export const RAW_EXTENSIONS = Object.keys(RAW_BY_EXTENSION).map((ext) => `.${ext}`);

const MEDIA_ACCEPT = 'image/*,video/*';

/**
 * The file input's `accept` list for this browser. Chrome on Android opens the photo picker
 * (Photos, Gallery) only when every entry is an image or video type: a RAW extension it can't map
 * to one sends guests to Camera or Files instead. Android indexes RAW photos as images, so they
 * still show in its photo picker. Elsewhere the extensions make Files apps and desktop dialogs
 * offer RAW.
 */
export function pickerAccept(userAgent: string): string {
  if (/\bAndroid\b/i.test(userAgent)) return MEDIA_ACCEPT;
  return [MEDIA_ACCEPT, ...RAW_EXTENSIONS].join(',');
}

const ALLOWED = new Set(Object.values(BY_EXTENSION));

// Other types systems report for RAW files. With a RAW extension, the file is declared under that
// extension's canonical type (the validator still checks the bytes).
const RAW_ALIASES = new Set([
  'image/dng',
  'image/tiff',
  'image/x-dcraw',
  'image/x-raw',
  'image/x-canon-raw',
  'image/x-fujifilm-raf',
  'image/x-nikon-raw',
  'image/x-olympus-raw',
  'image/x-panasonic-raw',
  'image/x-sony-raw',
]);

/** Returns the content type to declare for this file, or null if it isn't a supported photo/video. */
export function resolveContentType(file: Pick<File, 'name' | 'type'>): string | null {
  const declared = file.type.toLowerCase();
  if (ALLOWED.has(declared)) return declared;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (RAW_ALIASES.has(declared)) return RAW_BY_EXTENSION[ext] ?? null;
  if (declared && !declared.startsWith('application/octet-stream')) return null;
  return BY_EXTENSION[ext] ?? null;
}
