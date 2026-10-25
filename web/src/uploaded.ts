/**
 * @fileoverview Remembers which files this phone has uploaded to an event, so picking the same photo
 * again skips it instead of storing a second copy. A file is identified by its size plus a SHA-256
 * of its first and last MiB: hashing a whole 1 GiB video isn't practical on a phone. Storage can be
 * unavailable (private mode, blocked site data); the page then just doesn't skip anything, and the
 * server still drops exact repeats.
 */

const EDGE_BYTES = 1024 ** 2;
const MAX_REMEMBERED = 5000;

function storageKey(token: string): string {
  return `shotparty.uploaded.${token}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns a fingerprint of the file's content, or null when the browser can't hash it (no secure
 * context, or the file can't be read).
 */
export async function fingerprint(file: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !('subtle' in crypto)) return null;
  const head = file.slice(0, EDGE_BYTES);
  const tail = file.slice(Math.max(EDGE_BYTES, file.size - EDGE_BYTES));
  try {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await new Blob([head, tail]).arrayBuffer(),
    );
    return `${file.size}:${toHex(digest)}`;
  } catch {
    // Unreadable (e.g. the file was removed after picking): it just isn't checked for repeats.
    return null;
  }
}

/** Returns the remembered entry for a file fingerprint uploaded under this guest name. */
export function uploadedEntry(guestName: string, print: string): string {
  return `${guestName.trim().toLowerCase()}|${print}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function loadEntries(token: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(token)) ?? '[]');
    return isStringArray(stored) ? stored : [];
  } catch {
    // Storage blocked or corrupt: behave as if nothing was uploaded.
    return [];
  }
}

/** Returns the entries of every file this phone has uploaded to the event. */
export function loadUploaded(token: string): Set<string> {
  return new Set(loadEntries(token));
}

/** Remembers an uploaded file; only the most recent entries are kept. */
export function rememberUploaded(token: string, entry: string): void {
  const entries = loadEntries(token).filter((e) => e !== entry);
  entries.push(entry);
  try {
    localStorage.setItem(storageKey(token), JSON.stringify(entries.slice(-MAX_REMEMBERED)));
  } catch {
    // Non-essential: the server still drops an exact repeat.
  }
}
