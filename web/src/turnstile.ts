/**
 * @fileoverview Cloudflare Turnstile, rendered on demand. "interaction-only" keeps it invisible for
 * most guests; it only shows a checkbox when Cloudflare wants a human interaction.
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
 */
import { err, ok, type Result } from './result';

/** The part of Cloudflare's widget API this page uses. */
interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Human verification couldn't produce a token (script blocked, challenge failed or expired). */
export interface VerificationFailure {
  kind: 'verification-unavailable';
  message: string;
}

/** Returns a fresh single-use Turnstile token, or why there is none. */
export type GetTurnstileToken = () => Promise<Result<string, VerificationFailure>>;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** The widget action; must match api/src/lib/turnstile.ts. */
export const TURNSTILE_ACTION = 'upload-session';

function unavailable(message: string): Result<never, VerificationFailure> {
  return err({ kind: 'verification-unavailable', message });
}

let scriptPromise: Promise<Result<TurnstileApi, VerificationFailure>> | null = null;

function loadScript(): Promise<Result<TurnstileApi, VerificationFailure>> {
  scriptPromise ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      resolve(window.turnstile ? ok(window.turnstile) : unavailable('Turnstile unavailable'));
    };
    script.onerror = () => {
      scriptPromise = null; // allow a retry later
      resolve(unavailable('could not load human verification'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/** Returns a token getter for one widget per page; each call produces a fresh single-use token. */
export function createTurnstile(siteKey: string, container: HTMLElement): GetTurnstileToken {
  let widgetId: string | null = null;
  let settle: ((result: Result<string, VerificationFailure>) => void) | null = null;

  return async () => {
    const api = await loadScript();
    if (!api.ok) return api;
    const token = new Promise<Result<string, VerificationFailure>>((resolve) => {
      settle = resolve;
    });
    if (widgetId === null) {
      widgetId = api.value.render(container, {
        sitekey: siteKey,
        action: TURNSTILE_ACTION,
        appearance: 'interaction-only',
        execution: 'execute',
        callback: (t: string) => {
          settle?.(ok(t));
        },
        'error-callback': () => {
          settle?.(unavailable('human verification failed'));
        },
        'expired-callback': () => {
          settle?.(unavailable('human verification expired'));
        },
      });
    } else {
      api.value.reset(widgetId); // tokens are single-use: reset before asking for another
    }
    api.value.execute(widgetId);
    return token;
  };
}
