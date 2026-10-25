/**
 * @fileoverview Events gate uploads: guests reach an event through an unguessable token in the QR
 * link, may need a PIN printed on the card (not in the QR), and can only upload inside the event's
 * time window.
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { DEFAULT_LIMITS, type QuotaLimits } from './quota.js';

/** An event as stored in DynamoDB. */
export interface EventRecord {
  /** Secret, in the QR URL (/e/<token>). 128 bits, base64url. */
  token: string;
  /** Public folder name in S3 keys, e.g. "summer-party-2026". Never the token. */
  eventId: string;
  name: string;
  /** "scrypt$<salt>$<hash>" (base64url), absent when no PIN is required. */
  pinHash?: string;
  openFrom: string; // ISO 8601
  openUntil: string; // ISO 8601
  /** Per-event overrides of DEFAULT_LIMITS (e.g. tiny limits for a test event). */
  limits?: Partial<QuotaLimits>;
  /** Guest-page text and color; anything unset falls back to the page's neutral defaults. */
  display?: EventDisplay;
}

/** The organizer's own text and color for the guest page. */
export interface EventDisplay {
  /** Big title, e.g. "Share your photos". */
  headline?: string;
  /** Line under the headline, e.g. "Add your photos and videos from tonight." */
  welcome?: string;
  /** Shown once uploads finish, e.g. "Thanks for coming!" */
  thanks?: string;
  /** Buttons, links and highlights, as #rrggbb. */
  accentColor?: string;
}

/** Maximum length, in characters, of each display text field. */
const DISPLAY_TEXT_LIMITS = { headline: 80, welcome: 240, thanks: 240 } as const;
/** Every {@link EventDisplay} field, in display order. */
export const DISPLAY_FIELDS = ['headline', 'welcome', 'thanks', 'accentColor'] as const;
/** An accent color as stored: `#rrggbb`. */
export const ACCENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Trims the text fields, lowercases the color and drops empty values. Returns the cleaned display
 * plus every problem found (too long, bad color), so callers can report them all at once. The page
 * renders these with textContent only, so markup in them is shown literally, never interpreted.
 */
export function normalizeDisplay(input: Record<string, unknown>): {
  display: EventDisplay;
  problems: string[];
} {
  const display: EventDisplay = {};
  const problems: string[] = [];
  for (const field of DISPLAY_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      problems.push(`${field} must be text`);
      continue;
    }
    const value = raw.trim();
    if (!value) continue;
    if (field === 'accentColor') {
      if (ACCENT_COLOR_PATTERN.test(value)) {
        display.accentColor = value.toLowerCase();
      } else {
        problems.push(`accentColor must look like #1a2b3c (got "${value}")`);
      }
      continue;
    }
    const max = DISPLAY_TEXT_LIMITS[field];
    if ([...value].length > max) {
      problems.push(`${field} is longer than ${max} characters`);
    } else {
      display[field] = value;
    }
  }
  return { display, problems };
}

/** Returns the default limits (the install's, or the built-in ones) with the event's overrides. */
export function effectiveLimits(
  overrides?: Partial<QuotaLimits>,
  defaults: QuotaLimits = DEFAULT_LIMITS,
): QuotaLimits {
  return { ...defaults, ...overrides };
}

/** Where `now` falls relative to the event's upload window. */
export type WindowStatus = 'not-yet-open' | 'open' | 'closed';

/** The shape of an event token: anything else can't be a real event. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Returns a new 128-bit event token (base64url). */
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Returns a random numeric PIN with leading zeros kept. */
export function newPin(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

const SCRYPT_KEYLEN = 32;

/** Returns the stored form of a PIN: `scrypt$<salt>$<hash>`. */
export function hashPin(pin: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(normalizePin(pin), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Checks a guest's PIN against {@link hashPin} output, in constant time. */
export function verifyPin(pin: unknown, stored: string): boolean {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 32) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(normalizePin(pin), Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Guests type PINs on phones: ignore spaces/dashes and letter case. */
function normalizePin(pin: string): string {
  return pin.replace(/[\s-]/g, '').toUpperCase();
}

/** Returns whether uploads are not yet open, open or closed at `now`. */
export function windowStatus(
  event: Pick<EventRecord, 'openFrom' | 'openUntil'>,
  now: Date,
): WindowStatus {
  if (now < new Date(event.openFrom)) return 'not-yet-open';
  if (now > new Date(event.openUntil)) return 'closed';
  return 'open';
}

/** Lowercase ASCII words joined by "-", e.g. "Zoë & Sam!" -> "zoe-and-sam". */
export function slugify(text: string, maxLength = 48): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

/** The shape of an event ID (the S3 folder name): lowercase words joined by `-`. */
export const EVENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Returns the default event ID, e.g. "Summer Party" in 2026 -> "summer-party-2026". */
export function eventIdFromName(name: string, year: number): string {
  return `${slugify(name) || 'event'}-${year}`;
}

/**
 * The event's year as the organizer wrote it: "2026-12-31T18:00:00-08:00" is 2026, even though
 * it's already 2027 in UTC. Falls back to the local year of `now` when no date was given.
 */
export function yearOf(isoInput: string | undefined, now: Date = new Date()): number {
  const match = isoInput ? /^(\d{4})-/.exec(isoInput.trim()) : null;
  return match ? Number(match[1]) : now.getFullYear();
}

// ---------- DynamoDB item mapping (single-table: pk=EVENT#<token>, sk=META) ----------

/**
 * A DynamoDB primary key. A Record, not an interface: the SDK's `Key` is an index signature, which
 * interfaces don't satisfy.
 */
export type ItemKey = Record<'pk' | 'sk', { S: string }>;

/** Returns the key of an event's item. */
export function eventKey(token: string): ItemKey {
  return { pk: { S: `EVENT#${token}` }, sk: { S: 'META' } };
}

/** Returns the key that reserves an event ID (S3 folder name), so two events never share one. */
export function eventIdKey(eventId: string): ItemKey {
  return { pk: { S: `EVENTID#${eventId}` }, sk: { S: 'META' } };
}

/** A DynamoDB item as read back: string and number attributes only. */
export type AttributeMap = Record<string, { S?: string; N?: string } | undefined>;

// Object.keys of a QuotaLimits literal is exactly keyof QuotaLimits.
const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS) as Array<keyof QuotaLimits>;

/** Returns the item attribute that stores an event's override of one quota. */
export function limitAttr(key: keyof QuotaLimits): string {
  return `limit_${key}`;
}

/** Returns the DynamoDB item for an event. */
export function eventToItem(e: EventRecord): Record<string, { S: string } | { N: string }> {
  const limits = Object.fromEntries(
    LIMIT_KEYS.flatMap((k) => {
      const value = e.limits?.[k];
      return value === undefined ? [] : [[limitAttr(k), { N: String(value) }]];
    }),
  );
  return {
    ...eventKey(e.token),
    eventId: { S: e.eventId },
    name: { S: e.name },
    openFrom: { S: e.openFrom },
    openUntil: { S: e.openUntil },
    ...(e.pinHash ? { pinHash: { S: e.pinHash } } : {}),
    ...limits,
    ...displayToItem(e.display),
  };
}

/** Returns the item attribute that stores a display field. */
export function displayAttr(field: (typeof DISPLAY_FIELDS)[number]): string {
  return `display_${field}`;
}

function displayToItem(display?: EventDisplay): Record<string, { S: string }> {
  return Object.fromEntries(
    DISPLAY_FIELDS.flatMap((f) => {
      const value = display?.[f];
      return value ? [[displayAttr(f), { S: value }]] : [];
    }),
  );
}

function displayFromItem(item: AttributeMap): { display?: EventDisplay } {
  const entries = DISPLAY_FIELDS.flatMap((f) => {
    const v = item[displayAttr(f)]?.S;
    return v ? [[f, v] as const] : [];
  });
  return entries.length ? { display: Object.fromEntries(entries) } : {};
}

/** Reads an event item back; throws if a required attribute is missing (a corrupt item). */
export function eventFromItem(token: string, item: AttributeMap): EventRecord {
  const s = (k: string): string => {
    const v = item[k]?.S;
    if (v === undefined) throw new Error(`event item missing ${k}`);
    return v;
  };
  return {
    token,
    eventId: s('eventId'),
    name: s('name'),
    openFrom: s('openFrom'),
    openUntil: s('openUntil'),
    ...(item.pinHash?.S ? { pinHash: item.pinHash.S } : {}),
    ...limitsFromItem(item),
    ...displayFromItem(item),
  };
}

function limitsFromItem(item: AttributeMap): { limits?: Partial<QuotaLimits> } {
  const entries = LIMIT_KEYS.flatMap((k) => {
    const n = item[limitAttr(k)]?.N;
    return n === undefined ? [] : [[k, Number(n)] as const];
  });
  return entries.length ? { limits: Object.fromEntries(entries) } : {};
}
