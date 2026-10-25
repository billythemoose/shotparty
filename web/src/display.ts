/**
 * @fileoverview Per-event page text and accent color (set by the organizer with event:create /
 * event:update). Everything goes in through textContent or CSS custom properties, never as HTML.
 */
import { requireElement } from './dom';

/** The organizer's own text and color for the page (see api/src/lib/events.ts). */
export interface EventDisplay {
  headline?: string;
  welcome?: string;
  thanks?: string;
  accentColor?: string;
}

/** Shown when the event sets no headline. */
export const DEFAULT_HEADLINE = 'Share your photos';
/** Shown when the event sets no welcome line. */
export const DEFAULT_WELCOME = 'Add your photos and videos. Full quality, no app needed.';
/** Shown when the event sets no thank-you line. */
const DEFAULT_THANKS = 'Thank you!';

/** Page backgrounds from style.css; the accent must stand out against these. */
export const LIGHT_BG = '#f7f7f8';
/** The dark-mode page background. */
export const DARK_BG = '#141416';

/** Text on an accent-colored button. */
const LIGHT_TEXT = '#ffffff';
const DARK_TEXT = '#111113';

/** WCAG 2.x non-text contrast minimum (buttons, focus rings, links stand out from the page). */
const MIN_ACCENT_CONTRAST = 3;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16); // six hex digits, checked above
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Like parseHex, for colors this code supplies itself; throws on a bad one (a bug). */
function rgbOf(hex: string): Rgb {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`not a #rrggbb color: ${hex}`);
  return rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Returns the WCAG contrast ratio of two #rrggbb colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(rgbOf(a));
  const lb = luminance(rgbOf(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on the given color. */
export function textOn(hex: string): string {
  return contrastRatio(hex, LIGHT_TEXT) >= contrastRatio(hex, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * The organizer's color, nudged toward black (light page) or white (dark page) only as far as
 * needed to stand out from the background, so a pale yellow still works in light mode and a navy
 * still works in dark mode.
 */
export function readableAccent(hex: string, background: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const target: Rgb = luminance(rgbOf(background)) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let step = 0; step <= 20; step++) {
    const t = step / 20;
    const mix = (from: number, to: number): number => from + (to - from) * t;
    const mixed = toHex([mix(rgb[0], target[0]), mix(rgb[1], target[1]), mix(rgb[2], target[2])]);
    if (contrastRatio(mixed, background) >= MIN_ACCENT_CONTRAST) return mixed;
  }
  return toHex(target);
}

/** CSS custom properties for both color schemes (style.css picks the right pair). */
export function accentVariables(accentColor: string | undefined): Record<string, string> {
  if (!accentColor || !parseHex(accentColor)) return {};
  const light = readableAccent(accentColor, LIGHT_BG);
  const dark = readableAccent(accentColor, DARK_BG);
  return {
    '--event-accent-light': light,
    '--event-accent-fg-light': textOn(light),
    '--event-accent-dark': dark,
    '--event-accent-fg-dark': textOn(dark),
  };
}

/** Returns the summary shown once the queue is idle. */
export function thanksMessage(done: number, failed: number, custom?: string): string {
  const thanks = custom || DEFAULT_THANKS;
  return failed === 0
    ? `All ${done} uploaded. ${thanks} Add more any time.`
    : `${done} uploaded. ${thanks} ${failed} couldn't be uploaded.`;
}

/** Fills in the header and colors from the event; unset fields keep the neutral defaults. */
export function applyDisplay(doc: Document, eventName: string, display: EventDisplay = {}): void {
  const headline = display.headline || DEFAULT_HEADLINE;
  requireElement(doc, '#event-name').textContent = eventName;
  requireElement(doc, '#headline').textContent = headline;
  requireElement(doc, '#welcome').textContent = display.welcome || DEFAULT_WELCOME;
  doc.title = `${headline} · ${eventName}`;
  for (const [name, value] of Object.entries(accentVariables(display.accentColor))) {
    doc.documentElement.style.setProperty(name, value);
  }
}

/** Narrows an API value to an {@link EventDisplay}: an object of optional strings. */
export function isEventDisplay(value: unknown): value is EventDisplay {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>; // a non-null object, checked above
  return [v.headline, v.welcome, v.thanks, v.accentColor].every(
    (field) => field === undefined || typeof field === 'string',
  );
}
