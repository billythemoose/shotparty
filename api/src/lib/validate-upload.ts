/**
 * @fileoverview Decides what happens to a new upload: accepted (moved to accepted/) when its bytes
 * are real media and the guest hasn't already uploaded the same file, dropped as a duplicate when
 * they have, rejected (deleted and recorded) when it isn't media.
 */
import { type MediaKind, SNIFF_BYTES, sniffMedia } from './magic.js';
import type { Result } from './result.js';

/** The S3 object version an upload event refers to. */
export interface UploadedObject {
  bucket: string;
  key: string;
  versionId?: string;
  size: number;
}

/** The start of an upload, plus the object's ETag (for a single-part upload, its MD5). */
export interface ObjectHead {
  bytes: Uint8Array;
  etag: string;
}

/** Marks a guest's file content as taken by the upload that will land at `destKey`. */
export interface ContentClaim {
  eventId: string;
  guest: string;
  md5: string;
  destKey: string;
  at: string;
}

/** The guest already uploaded these exact bytes, now stored at `existingKey`. */
export interface DuplicateContent {
  kind: 'duplicate';
  existingKey: string;
}

/** Side effects, injected so the decision logic is testable without AWS. */
export interface ValidateDeps {
  /** First bytes of the object, or null if it no longer exists (already processed). */
  readHead(obj: UploadedObject, bytes: number): Promise<ObjectHead | null>;
  /**
   * Claims the content for this upload. Succeeds when nobody holds it, or when the same upload
   * already does (an EventBridge redelivery).
   */
  claimContent(claim: ContentClaim): Promise<Result<void, DuplicateContent>>;
  copy(obj: UploadedObject, destKey: string): Promise<void>;
  /** Permanently removes this exact version (no delete marker, nothing left to expire). */
  deleteVersion(obj: UploadedObject): Promise<void>;
  recordRejection(rejection: Rejection): Promise<void>;
  log(entry: Record<string, unknown>): void;
  now(): Date;
}

/** A refused upload, kept for the organizer (expires after 90 days). */
export interface Rejection {
  eventId: string;
  guest: string;
  key: string;
  size: number;
  reason: 'bad-magic';
  headHex: string;
  at: string;
}

/** What the validator did with an upload. */
export type Outcome =
  | { result: 'accepted'; kind: MediaKind; destKey: string }
  | { result: 'duplicate'; duplicateOf: string }
  | { result: 'rejected'; reason: 'bad-magic' }
  | { result: 'skipped'; reason: 'not-an-upload' | 'already-processed' };

/** uploads/<event>/<guest>/<file> -> accepted/<event>/<guest>/<file> */
export function acceptedKey(key: string): string {
  return `accepted/${key.slice('uploads/'.length)}`;
}

/**
 * Returns the MD5 an ETag stands for, or null when it isn't one (a multipart upload's ETag ends in
 * "-<parts>"). Guest uploads are single-part POSTs to an SSE-S3 bucket, so theirs always is.
 */
export function md5FromEtag(etag: string): string | null {
  const match = /^"?([0-9a-f]{32})"?$/i.exec(etag);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Sniffs the upload's first bytes and accepts or rejects it. */
export async function validateUpload(obj: UploadedObject, deps: ValidateDeps): Promise<Outcome> {
  if (!obj.key.startsWith('uploads/')) {
    deps.log({ result: 'skipped', reason: 'not-an-upload', key: obj.key });
    return { result: 'skipped', reason: 'not-an-upload' };
  }

  const head = await deps.readHead(obj, SNIFF_BYTES);
  if (!head) {
    // EventBridge delivers at-least-once; a repeat after we moved/deleted the object is a no-op.
    deps.log({ result: 'skipped', reason: 'already-processed', key: obj.key });
    return { result: 'skipped', reason: 'already-processed' };
  }

  const [, eventId = 'unknown', guest = 'unknown'] = obj.key.split('/');
  const kind = sniffMedia(head.bytes);
  if (kind) {
    const destKey = acceptedKey(obj.key);
    const md5 = md5FromEtag(head.etag);
    if (md5) {
      // Claimed before the copy, so two identical uploads racing each other keep exactly one.
      const at = deps.now().toISOString();
      const claim = await deps.claimContent({ eventId, guest, md5, destKey, at });
      if (!claim.ok) {
        const duplicateOf = claim.error.existingKey;
        await deps.deleteVersion(obj);
        deps.log({ result: 'duplicate', key: obj.key, duplicateOf, size: obj.size });
        return { result: 'duplicate', duplicateOf };
      }
    } else {
      deps.log({ note: 'no-md5-etag', key: obj.key, etag: head.etag });
    }
    await deps.copy(obj, destKey);
    await deps.deleteVersion(obj);
    deps.log({ result: 'accepted', kind, key: obj.key, destKey, size: obj.size });
    return { result: 'accepted', kind, destKey };
  }

  const headHex = Buffer.from(head.bytes.subarray(0, 16)).toString('hex');
  await deps.deleteVersion(obj);
  await deps.recordRejection({
    eventId,
    guest,
    key: obj.key,
    size: obj.size,
    reason: 'bad-magic',
    headHex,
    at: deps.now().toISOString(),
  });
  deps.log({ result: 'rejected', reason: 'bad-magic', key: obj.key, size: obj.size, headHex });
  return { result: 'rejected', reason: 'bad-magic' };
}
