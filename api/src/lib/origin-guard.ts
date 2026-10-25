/**
 * @fileoverview Only requests that came through CloudFront are served: the public execute-api URL
 * would otherwise bypass the CloudFront WAF rate limit. CloudFront proves itself with
 * x-origin-verify (added by the ApiViewerFunction); anything else gets a 403 before any real work.
 */
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { clientIp } from './client-ip.js';
import { json, requireEnv } from './http.js';
import { getSecret } from './secrets.js';

/** Returns a 403 response for a request that bypassed CloudFront, or null to carry on. */
export async function rejectIfNotViaCloudFront(event: {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { sourceIp?: string } };
}): Promise<APIGatewayProxyStructuredResultV2 | null> {
  // Cheap pre-check: no header at all means a direct call; skip the secret lookup.
  if (!event.headers?.['x-origin-verify']) return json(403, { error: 'forbidden' });
  const { viaCloudFront } = clientIp(
    event.headers,
    event.requestContext?.http?.sourceIp ?? '',
    await getSecret(requireEnv('ORIGIN_VERIFY_PARAM')),
  );
  return viaCloudFront ? null : json(403, { error: 'forbidden' });
}
