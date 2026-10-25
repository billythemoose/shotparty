/**
 * @fileoverview Pure rules for which uploads are allowed and how they're stored. The presign
 * handler turns these into an S3 POST policy, which S3 itself enforces (size, content type, exact
 * key).
 */
import type { PresignedPostOptions } from '@aws-sdk/s3-presigned-post';
import { err, ok, type Result } from './result.js';

/** Default per-file cap, 1 GiB (a single POST; see ARCHITECTURE.md, "Design choices"). Set by uploads.maxFileGb. */
export const MAX_UPLOAD_BYTES = 1024 ** 3;
/** How long a presigned POST stays usable. */
export const PRESIGN_EXPIRES_SECONDS = 600;

// Explicit allow-list: prefix matching on image/* would also admit e.g. image/svg+xml (scriptable).
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  // Camera RAW. Browsers report these inconsistently; the page declares one type per format.
  'image/x-adobe-dng': 'dng',
  'image/x-canon-cr2': 'cr2',
  'image/x-canon-cr3': 'cr3',
  'image/x-nikon-nef': 'nef',
  'image/x-sony-arw': 'arw',
  'image/x-fuji-raf': 'raf',
  'image/x-olympus-orf': 'orf',
  'image/x-panasonic-rw2': 'rw2',
};

/** Every content type a guest may upload. */
const ALLOWED_CONTENT_TYPES = Object.keys(EXTENSIONS);

/** A validated presign request. */
export interface UploadRequest {
  filename: string;
  contentType: string;
  size: number;
  /** Already slugified; "anonymous" when the guest gave no usable name. */
  guestSlug: string;
}

const MAX_GUEST_NAME = 80;

/**
 * Turns a free-text guest name into a safe key segment: "Zoë O'Brien" -> "zoe-o-brien".
 * Runs server-side; the client-supplied name is never used in a key as-is.
 */
export function guestSlug(name: unknown): string {
  if (typeof name !== 'string') return 'anonymous';
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'anonymous';
}

/** A presign request that breaks a rule; `message` says which, for the guest's 400 response. */
export interface InvalidUploadRequest {
  kind: 'invalid-request';
  message: string;
}

function invalid(message: string): Result<never, InvalidUploadRequest> {
  return err({ kind: 'invalid-request', message });
}

/**
 * Checks a presign request body and normalizes it (lowercase content type, slugified guest).
 * Files over `maxBytes` are refused.
 */
export function validateUploadRequest(
  body: Record<string, unknown>,
  maxBytes = MAX_UPLOAD_BYTES,
): Result<UploadRequest, InvalidUploadRequest> {
  const { filename, contentType, size, guestName } = body;

  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
    return invalid('filename must be a string of 1-255 characters');
  }
  if (typeof contentType !== 'string' || !(contentType.toLowerCase() in EXTENSIONS)) {
    return invalid(`contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > maxBytes) {
    return invalid(`size must be an integer from 1 to ${maxBytes} bytes`);
  }
  if (
    guestName !== undefined &&
    (typeof guestName !== 'string' || guestName.length > MAX_GUEST_NAME)
  ) {
    return invalid(`guestName must be a string of at most ${MAX_GUEST_NAME} characters`);
  }
  return ok({
    filename,
    contentType: contentType.toLowerCase(),
    size,
    guestSlug: guestSlug(guestName),
  });
}

/**
 * Server-chosen key: guests never control the path. The extension comes from the (allow-listed)
 * content type, not the filename, so a "photo.exe" declared as image/jpeg is stored as .jpg.
 */
export function objectKey(eventId: string, guest: string, id: string, contentType: string): string {
  const ext = EXTENSIONS[contentType];
  if (!ext) throw new Error(`Unsupported content type ${contentType}`);
  return `uploads/${eventId}/${guest}/${id}.${ext}`;
}

/**
 * POST policy conditions beyond the key (which createPresignedPost adds itself). The byte range is
 * pinned to the declared size, so S3 rejects any body larger (or smaller) than what was approved.
 */
export function postConditions(
  req: UploadRequest,
): NonNullable<PresignedPostOptions['Conditions']> {
  return [
    ['content-length-range', req.size, req.size],
    ['eq', '$Content-Type', req.contentType],
  ];
}
