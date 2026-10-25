/**
 * @fileoverview The install-wide upload limits from shotparty.config.json (`uploads`), which the
 * app stack passes to the presign Lambda as environment variables. Unset variables fall back to
 * the built-in defaults; events can still override the quotas one by one.
 */
import { DEFAULT_LIMITS, type QuotaLimits } from './quota.js';
import { MAX_UPLOAD_BYTES } from './upload-policy.js';

/** The per-file cap and the quotas events start from. */
export interface UploadLimits {
  maxFileBytes: number;
  defaults: QuotaLimits;
}

/** Reads the limits from the environment; throws on a malformed value (a deploy mistake). */
export function uploadLimitsFromEnv(env: Record<string, string | undefined>): UploadLimits {
  return {
    maxFileBytes: positiveInteger(env, 'MAX_UPLOAD_BYTES', MAX_UPLOAD_BYTES),
    defaults: {
      ...DEFAULT_LIMITS,
      sessionFiles: positiveInteger(env, 'DEFAULT_SESSION_FILES', DEFAULT_LIMITS.sessionFiles),
      sessionBytes: positiveInteger(env, 'DEFAULT_SESSION_BYTES', DEFAULT_LIMITS.sessionBytes),
    },
  };
}

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
