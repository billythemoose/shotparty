/**
 * @fileoverview Results for expected failures, plus the assertion helpers that go with them.
 * Expected failures (a wrong PIN, a full quota) are returned so the compiler makes callers handle
 * every kind; exceptions are kept for bugs and broken invariants. A copy of api/src/lib/result.ts
 * (the page is bundled separately from the API and doesn't import across packages).
 */

/** Either a value or the reason there is none. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** An error variant that needs no context beyond its kind. */
export interface Failure<K extends string> {
  kind: K;
}

/** Wraps a success. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps an expected failure. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Marks the end of an exhaustive switch: adding a variant breaks every caller that misses it. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

/** Narrows a caught value; everything this code base calls throws Errors. */
export function assertIsError(e: unknown): asserts e is Error {
  if (!(e instanceof Error)) {
    throw new Error(`non-Error thrown: ${String(e)}`);
  }
}
