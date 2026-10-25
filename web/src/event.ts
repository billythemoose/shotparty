/** @fileoverview Looks up the event the QR link points at, and decides whether to show the uploader. */
import { type EventDisplay, isEventDisplay } from './display';
import { err, ok, type Result } from './result';

/** Extracts the event token from a path like /e/<token>. */
export function eventTokenFromPath(pathname: string): string | null {
  const match = /^\/e\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

const STATUSES = ['not-yet-open', 'open', 'closed'] as const;

/** GET /api/event/<token>. */
export interface EventInfo {
  name: string;
  /** The event's own page text and accent color (absent from older API versions). */
  display?: EventDisplay;
  requiresPin: boolean;
  status: (typeof STATUSES)[number];
  openFrom: string;
  openUntil: string;
  uploadsEnabled: boolean;
  turnstileSiteKey: string;
}

/** Why the uploader isn't shown: `message` is for the guest; `event` is there when it loaded. */
export interface EventUnavailable {
  kind: 'event-unavailable';
  message: string;
  event?: EventInfo;
}

function isEventInfo(value: unknown): value is EventInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>; // a non-null object, checked above
  return (
    typeof v.name === 'string' &&
    (v.display === undefined || isEventDisplay(v.display)) &&
    typeof v.requiresPin === 'boolean' &&
    STATUSES.some((s) => s === v.status) &&
    typeof v.openFrom === 'string' &&
    typeof v.openUntil === 'string' &&
    typeof v.uploadsEnabled === 'boolean' &&
    typeof v.turnstileSiteKey === 'string'
  );
}

function unavailable(message: string, event?: EventInfo): Result<never, EventUnavailable> {
  return err({ kind: 'event-unavailable', message, ...(event ? { event } : {}) });
}

/** Returns the event when guests can upload to it now, else the message to show instead. */
export async function loadEvent(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
  formatDate: (iso: string) => string = defaultFormatDate,
): Promise<Result<EventInfo, EventUnavailable>> {
  if (!token) return unavailable('Scan the event’s QR code to share your photos.');
  let res: Response;
  try {
    res = await fetchImpl(`/api/event/${encodeURIComponent(token)}`, { cache: 'no-store' });
  } catch {
    // fetch rejects only when no response arrived.
    return unavailable('Can’t reach the server. Check your connection and reload.');
  }
  if (res.status === 404) {
    return unavailable('This link isn’t valid. Please scan the event’s QR code again.');
  }
  const event: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
  if (!isEventInfo(event)) return unavailable('Something went wrong. Please reload the page.');

  if (event.status === 'not-yet-open') {
    return unavailable(`Uploads open ${formatDate(event.openFrom)}.`, event);
  }
  if (event.status === 'closed') {
    return unavailable('Uploads for this event have closed. Thank you!', event);
  }
  if (!event.uploadsEnabled) {
    return unavailable('Uploads are paused right now. Please try again later.', event);
  }
  return ok(event);
}

function defaultFormatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
