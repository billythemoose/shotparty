/** @fileoverview Decides whether an upload may be presigned, before any S3 signing happens. */
import { type EventRecord, TOKEN_PATTERN, verifyPin, windowStatus } from './events.js';
import { assertNever, err, type Failure, ok, type Result } from './result.js';

/** What the gate reads: the kill switch, the event and the clock. */
export interface GateDeps {
  /** Kill switch (SSM /shotparty/<stage>/uploads_enabled). */
  uploadsEnabled(): Promise<boolean>;
  getEvent(token: string): Promise<EventRecord | null>;
  now(): Date;
}

/** Why an upload was refused. The kind is also the API's `error` code. */
export type GateError =
  | Failure<'uploads-disabled'>
  | Failure<'missing-event'>
  | Failure<'unknown-event'>
  | Failure<'not-yet-open'>
  | Failure<'closed'>
  | Failure<'pin-required'>
  | Failure<'wrong-pin'>;

/** Options for {@link checkUploadAllowed}. */
export interface GateOptions {
  /** Presign passes true: the PIN was already checked when the session was issued. */
  pinAlreadyVerified?: boolean;
}

/** Returns the event when uploads to it are allowed right now, else why not. */
export async function checkUploadAllowed(
  input: { eventToken: unknown; pin: unknown },
  deps: GateDeps,
  opts: GateOptions = {},
): Promise<Result<EventRecord, GateError>> {
  if (!(await deps.uploadsEnabled())) return err({ kind: 'uploads-disabled' });

  const { eventToken, pin } = input;
  if (typeof eventToken !== 'string' || eventToken === '') return err({ kind: 'missing-event' });
  // Malformed tokens can't exist, so answer like an unknown one without a database read.
  if (!TOKEN_PATTERN.test(eventToken)) return err({ kind: 'unknown-event' });

  const event = await deps.getEvent(eventToken);
  if (!event) return err({ kind: 'unknown-event' });

  const status = windowStatus(event, deps.now());
  if (status !== 'open') return err({ kind: status });

  if (event.pinHash && !opts.pinAlreadyVerified) {
    if (pin === undefined || pin === '') return err({ kind: 'pin-required' });
    if (!verifyPin(pin, event.pinHash)) return err({ kind: 'wrong-pin' });
  }
  return ok(event);
}

/** Returns the HTTP status for a refusal. */
export function gateErrorStatus(error: GateError): 400 | 403 | 404 | 503 {
  switch (error.kind) {
    case 'uploads-disabled':
      return 503;
    case 'missing-event':
      return 400;
    case 'unknown-event':
      return 404;
    case 'not-yet-open':
    case 'closed':
    case 'pin-required':
    case 'wrong-pin':
      return 403;
    default:
      return assertNever(error);
  }
}

/** A cache lookup: returns the cached value for `key`, or loads and caches it. */
export type TtlCache<V> = (key: string, load: () => Promise<V>) => Promise<V>;

/** Returns a tiny per-container TTL cache: Lambda containers are reused, so this saves most lookups. */
export function ttlCache<V>(ttlMs: number, now: () => number = Date.now): TtlCache<V> {
  const entries = new Map<string, { value: V; expires: number }>();
  return async (key, load) => {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const value = await load();
    entries.set(key, { value, expires: now() + ttlMs });
    return value;
  };
}
