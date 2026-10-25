/**
 * @fileoverview Talks to the API (session, presign) and to S3 (the upload itself). Every call
 * returns a Result: the queue retries some failures and shows the guest the rest.
 */
import { assertNever, err, ok, type Result } from './result';
import type { VerificationFailure } from './turnstile';

/** A presigned S3 POST: where to send the file and the policy fields that must come first. */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  key: string;
}

/** An upload session, as the API issues it. */
export interface SessionGrant {
  session: string;
  expiresAt: number; // epoch seconds
}

/** What {@link requestPresign} needs to know about the file. */
export interface PresignInput {
  file: Pick<File, 'name' | 'size'>;
  contentType: string;
  session: string;
  guestName?: string;
}

/** The request never reached the server, or its response never arrived. */
export interface NetworkFailure {
  kind: 'network';
  message: 'network error' | 'timed out';
}

/** The API refused the request; `code` is its error code ('' when it gave none). */
export interface ApiRefusal {
  kind: 'api-refused';
  status: number;
  code: string;
}

/** S3 refused the upload; `code` is from its XML error body, when there was one. */
export interface S3Refusal {
  kind: 's3-refused';
  status: number;
  code?: string;
  /** The presigned POST's policy had expired (a new one fixes it). */
  expired: boolean;
}

/** The API answered 2xx with a body this page doesn't understand. */
export interface UnexpectedResponse {
  kind: 'unexpected-response';
  url: string;
}

/** Any reason an upload, or a step towards it, failed. */
export type UploadFailure =
  NetworkFailure | ApiRefusal | S3Refusal | UnexpectedResponse | VerificationFailure;

/** Guest-facing text for API error codes (see api/src/lib/gate.ts). */
const MESSAGES: Record<string, string> = {
  'pin-required': 'enter the PIN from your card',
  'wrong-pin': 'wrong PIN, check your card',
  'uploads-disabled': 'uploads are paused, try again later',
  closed: 'uploads have closed',
  'not-yet-open': 'uploads aren’t open yet',
  'unknown-event': 'this link isn’t valid',
  'verification-failed': 'couldn’t verify, please try again',
  'session-quota': 'upload limit reached for this phone',
  'ip-rate-limit': 'too many uploads from this network, try again in an hour',
  'event-quota': 'the album is full',
};

/** Quotas don't free up within the retry backoff, so these fail immediately. */
const QUOTA_ERRORS = new Set(['session-quota', 'ip-rate-limit', 'event-quota']);

/** API error codes that mean the guest must fix the PIN. */
export const PIN_ERRORS = new Set(['pin-required', 'wrong-pin']);
/** The server no longer accepts our session: drop it and get a new one. */
export const SESSION_ERRORS = new Set(['session-required', 'invalid-session', 'session-expired']);

/** Returns whether trying again could succeed (network, 5xx, throttling, an expired link). */
export function isRetryable(failure: UploadFailure): boolean {
  switch (failure.kind) {
    case 'network':
    case 'verification-unavailable':
      return true;
    case 'api-refused':
      return (
        !QUOTA_ERRORS.has(failure.code) &&
        (failure.status >= 500 ||
          failure.status === 429 ||
          SESSION_ERRORS.has(failure.code) ||
          failure.code === 'verification-failed')
      );
    case 's3-refused':
      return (
        failure.status >= 500 ||
        failure.status === 0 ||
        failure.expired ||
        failure.code === 'RequestTimeout'
      );
    case 'unexpected-response':
      return false;
    default:
      return assertNever(failure);
  }
}

/** Returns the text shown to the guest next to the file. */
export function failureMessage(failure: UploadFailure): string {
  switch (failure.kind) {
    case 'network':
    case 'verification-unavailable':
      return failure.message;
    case 'api-refused':
      return MESSAGES[failure.code] ?? (failure.code || `server error (HTTP ${failure.status})`);
    case 's3-refused':
      return `upload rejected: ${failure.code ?? `HTTP ${failure.status}`}`;
    case 'unexpected-response':
      return 'unexpected server response';
    default:
      return assertNever(failure);
  }
}

/** S3 POST requires every policy field before the file, and the file must be the last part. */
export function buildUploadForm(fields: Record<string, string>, file: Blob): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  form.append('file', file);
  return form;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a stored or received value to a session grant. */
export function isSessionGrant(value: unknown): value is SessionGrant {
  return (
    isRecord(value) && typeof value.session === 'string' && typeof value.expiresAt === 'number'
  );
}

function isPresignedPost(value: unknown): value is PresignedPost {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.key === 'string' &&
    isRecord(value.fields) &&
    Object.values(value.fields).every((v) => typeof v === 'string')
  );
}

async function postJson<T>(
  url: string,
  body: unknown,
  isExpected: (value: unknown) => value is T,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
): Promise<Result<T, UploadFailure>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch rejects only when no response arrived.
    return err({ kind: 'network', message: 'network error' });
  }
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const code = isRecord(json) && typeof json.error === 'string' ? json.error : '';
    return err({ kind: 'api-refused', status: res.status, code });
  }
  return isExpected(json) ? ok(json) : err({ kind: 'unexpected-response', url });
}

/** Asks the API for an upload session (after Turnstile, plus the PIN when the event has one). */
export function createSession(
  input: { eventToken: string; pin?: string; turnstileToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Result<SessionGrant, UploadFailure>> {
  const { eventToken, pin, turnstileToken } = input;
  return postJson(
    '/api/session',
    { eventToken, turnstileToken, ...(pin ? { pin } : {}) },
    isSessionGrant,
    fetchImpl,
  );
}

/** Asks the API for a presigned POST for one file. */
export function requestPresign(
  { file, contentType, session, guestName }: PresignInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<PresignedPost, UploadFailure>> {
  return postJson(
    '/api/presign',
    {
      filename: file.name,
      contentType,
      size: file.size,
      ...(guestName ? { guestName } : {}),
    },
    isPresignedPost,
    fetchImpl,
    { authorization: `Bearer ${session}` },
  );
}

/** Reads an S3 POST failure from its status and XML error body. */
export function s3Error(status: number, responseText: string): S3Refusal {
  const code = /<Code>([^<]+)<\/Code>/.exec(responseText)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(responseText)?.[1] ?? '';
  const expired = code === 'AccessDenied' && /expired/i.test(message);
  return { kind: 's3-refused', status, ...(code ? { code } : {}), expired };
}

/** Uploads the file to S3. XHR rather than fetch: fetch has no upload-progress events. */
export function postWithProgress(
  post: PresignedPost,
  file: Blob,
  onProgress: (fraction: number) => void,
): Promise<Result<void, UploadFailure>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', post.url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const succeeded = xhr.status >= 200 && xhr.status < 300;
      resolve(succeeded ? ok(undefined) : err(s3Error(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => {
      resolve(err({ kind: 'network', message: 'network error' }));
    };
    xhr.ontimeout = () => {
      resolve(err({ kind: 'network', message: 'timed out' }));
    };
    xhr.send(buildUploadForm(post.fields, file));
  });
}
