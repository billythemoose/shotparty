/**
 * @fileoverview Cloudflare Turnstile server-side validation (the client widget alone proves
 * nothing). https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

import { assertNever, err, type Failure, ok, type Result } from './result.js';

/** Cloudflare's server-side validation endpoint. */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The action the guest page's widget declares; tokens for any other action are refused. */
export const TURNSTILE_ACTION = 'upload-session';

/** What a valid token must also match. */
export interface TurnstileExpectations {
  action: string;
  /** Hostnames the widget may be served from; empty = don't check (Cloudflare test keys). */
  hostnames: string[];
}

/** The input a Turnstile check needs. */
export interface TurnstileInput {
  secret: string;
  token: unknown;
  remoteIp?: string;
}

/** Cloudflare refused the token, with its error codes (e.g. `timeout-or-duplicate`). */
export interface TurnstileRejected {
  kind: 'rejected';
  codes: string[];
}

/** The token was issued for a page on another hostname. */
export interface UnexpectedHostname {
  kind: 'unexpected-hostname';
  hostname: string;
}

/** The token was issued for a different widget action. */
export interface UnexpectedAction {
  kind: 'unexpected-action';
  action: string;
}

/** Why a Turnstile token didn't prove a human. */
export type TurnstileError =
  | Failure<'missing-token'>
  | Failure<'invalid-token'>
  | Failure<'siteverify-unreachable'>
  | TurnstileRejected
  | UnexpectedHostname
  | UnexpectedAction;

/** The siteverify response fields this code reads. */
interface SiteverifyBody {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
}

function isSiteverifyBody(value: unknown): value is SiteverifyBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>; // a non-null object, checked above
  const codes = body['error-codes'];
  return (
    typeof body.success === 'boolean' &&
    (codes === undefined || (Array.isArray(codes) && codes.every((c) => typeof c === 'string'))) &&
    (body.hostname === undefined || typeof body.hostname === 'string') &&
    (body.action === undefined || typeof body.action === 'string')
  );
}

/** Verifies a widget token with Cloudflare (siteverify), including its hostname and action. */
export async function verifyTurnstile(
  input: TurnstileInput,
  expect: TurnstileExpectations,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<void, TurnstileError>> {
  const { secret, token, remoteIp } = input;
  if (typeof token !== 'string' || token.length === 0) return err({ kind: 'missing-token' });
  if (token.length > 2048) return err({ kind: 'invalid-token' });

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);

  let body: unknown;
  try {
    const res = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body: form });
    body = await res.json();
  } catch {
    // Network failure or a non-JSON reply: either way Cloudflare gave no verdict.
    return err({ kind: 'siteverify-unreachable' });
  }
  if (!isSiteverifyBody(body)) return err({ kind: 'siteverify-unreachable' });

  if (!body.success) return err({ kind: 'rejected', codes: body['error-codes'] ?? [] });
  // Test keys report a fixed/absent action, so only enforce it when hostnames are enforced.
  if (expect.hostnames.length > 0) {
    if (!body.hostname || !expect.hostnames.includes(body.hostname)) {
      return err({ kind: 'unexpected-hostname', hostname: body.hostname ?? '' });
    }
    if (body.action !== expect.action) {
      return err({ kind: 'unexpected-action', action: body.action ?? '' });
    }
  }
  return ok(undefined);
}

/** Returns the reason as it appears in the `turnstile-failed` log line. */
export function describeTurnstileError(error: TurnstileError): string {
  switch (error.kind) {
    case 'missing-token':
    case 'invalid-token':
    case 'siteverify-unreachable':
      return error.kind;
    case 'rejected':
      return error.codes.join(',') || 'failed';
    case 'unexpected-hostname':
      return `unexpected-hostname:${error.hostname}`;
    case 'unexpected-action':
      return `unexpected-action:${error.action}`;
    default:
      return assertNever(error);
  }
}
