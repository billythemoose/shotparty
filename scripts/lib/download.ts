/**
 * @fileoverview Pure helpers for scripts/download-all.ts: where each object lands locally, the
 * manifest, and checksum verification (our uploads are single-part POSTs, so the S3 ETag is the
 * file's MD5).
 */
import { downloadName, guestOf } from './gallery.js';

/** An accepted object as listed in S3. */
export interface StoredObject {
  key: string;
  size: number;
  etag: string; // with or without surrounding quotes
  lastModified: Date;
}

/** An object and where it lands locally. */
export interface PlannedFile extends StoredObject {
  guest: string;
  relativePath: string; // <guest>/<guest>_<timestamp>_<id8>.<ext>
  md5: string | null; // null when the ETag isn't a plain MD5 (multipart upload)
}

/** Returns where each object goes: one folder per guest, readable file names. */
export function planDownload(objects: StoredObject[]): PlannedFile[] {
  return objects.map((o) => {
    const guest = guestOf(o.key) || 'unknown';
    const etag = o.etag.replace(/"/g, '');
    return {
      ...o,
      guest,
      relativePath: `${guest}/${downloadName({ key: o.key, guest, uploadedAt: o.lastModified })}`,
      md5: /^[0-9a-f]{32}$/.test(etag) ? etag : null,
    };
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Returns manifest.csv: one row per file, with its MD5 when S3 knows it. */
export function manifestCsv(files: PlannedFile[]): string {
  const header = ['file', 'guest', 'uploaded_utc', 'bytes', 'md5', 's3_key'];
  const rows = files.map((f) =>
    [f.relativePath, f.guest, f.lastModified.toISOString(), f.size, f.md5 ?? '', f.key].map((v) =>
      csvCell(v),
    ),
  );
  return [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
}

/** How a local copy compares with S3. */
export type Verdict = 'ok' | 'size-mismatch' | 'md5-mismatch' | 'missing';

/** Compares a local file (null if absent) with what S3 has. */
export function verifyFile(
  planned: Pick<PlannedFile, 'size' | 'md5'>,
  local: { size: number; md5: string } | null,
): Verdict {
  if (!local) return 'missing';
  if (local.size !== planned.size) return 'size-mismatch';
  if (planned.md5 && local.md5 !== planned.md5) return 'md5-mismatch';
  return 'ok';
}
