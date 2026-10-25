/**
 * @fileoverview Remembers the guest's name on this phone. Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and the page works without it.
 */

const KEY = 'shotparty.guestName';

/** Returns the guest's remembered name, or ''. */
export function loadGuestName(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    // Storage blocked: behave as if nothing was saved.
    return '';
  }
}

/** Remembers the guest's name; an empty name forgets it. */
export function saveGuestName(name: string): void {
  try {
    if (name) {
      localStorage.setItem(KEY, name);
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    // Non-essential convenience; ignore.
  }
}

function pinKey(token: string): string {
  return `shotparty.pin.${token}`;
}

/** Returns the PIN remembered for this event, or ''. */
export function loadPin(token: string): string {
  try {
    return localStorage.getItem(pinKey(token)) ?? '';
  } catch {
    // Storage blocked: behave as if nothing was saved.
    return '';
  }
}

/** Remembers the PIN for this event; an empty PIN forgets it. */
export function savePin(token: string, pin: string): void {
  try {
    if (pin) {
      localStorage.setItem(pinKey(token), pin);
    } else {
      localStorage.removeItem(pinKey(token));
    }
  } catch {
    // Non-essential convenience; ignore.
  }
}
