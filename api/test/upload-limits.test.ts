import { describe, expect, it } from 'vitest';
import { effectiveLimits } from '../src/lib/events.js';
import { DEFAULT_LIMITS } from '../src/lib/quota.js';
import { uploadLimitsFromEnv } from '../src/lib/upload-limits.js';
import { MAX_UPLOAD_BYTES } from '../src/lib/upload-policy.js';

describe('uploadLimitsFromEnv', () => {
  it('falls back to the built-in limits when nothing is set', () => {
    expect(uploadLimitsFromEnv({})).toEqual({
      maxFileBytes: MAX_UPLOAD_BYTES,
      defaults: DEFAULT_LIMITS,
    });
    expect(uploadLimitsFromEnv({ MAX_UPLOAD_BYTES: '' }).maxFileBytes).toBe(MAX_UPLOAD_BYTES);
  });

  it('reads the per-file cap and the session defaults', () => {
    const limits = uploadLimitsFromEnv({
      MAX_UPLOAD_BYTES: String(2 * 1024 ** 3),
      DEFAULT_SESSION_FILES: '2000',
      DEFAULT_SESSION_BYTES: String(50 * 1024 ** 3),
    });
    expect(limits).toEqual({
      maxFileBytes: 2 * 1024 ** 3,
      defaults: { ...DEFAULT_LIMITS, sessionFiles: 2000, sessionBytes: 50 * 1024 ** 3 },
    });
  });

  it.each(['0', '-5', '1.5', 'ten', '1e400'])('throws on a malformed value: %s', (raw) => {
    expect(() => uploadLimitsFromEnv({ DEFAULT_SESSION_FILES: raw })).toThrow(
      /DEFAULT_SESSION_FILES must be a positive integer/,
    );
  });
});

describe('effectiveLimits', () => {
  it("applies an event's overrides on top of the install's defaults", () => {
    const defaults = { ...DEFAULT_LIMITS, sessionFiles: 2000 };
    expect(effectiveLimits({ eventFiles: 10 }, defaults)).toEqual({
      ...defaults,
      eventFiles: 10,
    });
    expect(effectiveLimits({ sessionFiles: 3 }, defaults).sessionFiles).toBe(3);
  });
});
