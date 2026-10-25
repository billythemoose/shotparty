/**
 * @fileoverview Holds the upload session for one event: created on first need (Turnstile + PIN),
 * reused by all uploads, remembered across reloads until shortly before it expires, and renewed on
 * 401.
 */
import { ok, type Result } from './result';
import type { GetTurnstileToken } from './turnstile';
import { createSession, isSessionGrant, type SessionGrant, type UploadFailure } from './upload';

const RENEW_MARGIN_SECONDS = 5 * 60;

/** Where the session is remembered between page loads. */
export interface SessionStorage {
  load(): SessionGrant | null;
  save(grant: SessionGrant | null): void;
}

/** What a {@link SessionManager} needs. */
export interface SessionManagerDeps {
  eventToken: string;
  getPin: () => string;
  getTurnstileToken: GetTurnstileToken;
  storage: SessionStorage;
  now?: () => number;
  create?: typeof createSession;
}

/** Holds one event's upload session: shared by all uploads, renewed shortly before it expires. */
export class SessionManager {
  private inFlight: Promise<Result<string, UploadFailure>> | null = null;

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Returns a usable session token, creating one if needed. Concurrent callers share one request. */
  ensure(): Promise<Result<string, UploadFailure>> {
    const cached = this.deps.storage.load();
    const nowSeconds = (this.deps.now ?? Date.now)() / 1000;
    if (cached && cached.expiresAt - RENEW_MARGIN_SECONDS > nowSeconds) {
      return Promise.resolve(ok(cached.session));
    }
    this.inFlight ??= this.create().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Forgets the session (the server refused it), so the next upload gets a new one. */
  clear(): void {
    this.deps.storage.save(null);
  }

  private async create(): Promise<Result<string, UploadFailure>> {
    const turnstileToken = await this.deps.getTurnstileToken();
    if (!turnstileToken.ok) return turnstileToken;
    const grant = await (this.deps.create ?? createSession)({
      eventToken: this.deps.eventToken,
      pin: this.deps.getPin(),
      turnstileToken: turnstileToken.value,
    });
    if (!grant.ok) return grant;
    this.deps.storage.save(grant.value);
    return ok(grant.value.session);
  }
}

/** Returns storage that keeps the session in localStorage, per event token. */
export function localSessionStorage(eventToken: string): SessionStorage {
  const key = `shotparty.session.${eventToken}`;
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        const stored: unknown = raw ? JSON.parse(raw) : null;
        return isSessionGrant(stored) ? stored : null;
      } catch {
        // Storage blocked or a corrupt value: same as having no session.
        return null;
      }
    },
    save(grant) {
      try {
        if (grant) {
          localStorage.setItem(key, JSON.stringify(grant));
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        // Private mode etc.: the session just lives for this page load.
      }
    },
  };
}
