import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** Returns an uncacheable JSON response. */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/** Returns an environment variable; throws if it is unset (a deployment bug). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/** Parses a (possibly base64) JSON object body; null if absent, invalid, or not an object. */
export function parseJsonBody(event: {
  body?: string;
  isBase64Encoded?: boolean;
}): Record<string, unknown> | null {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString()
      : event.body;
    const parsed: unknown = JSON.parse(raw ?? '');
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    // Not JSON (or not valid base64): the same answer as a body that isn't an object.
    return null;
  }
}

/** Narrows a parsed JSON value to an object (not an array or null). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
