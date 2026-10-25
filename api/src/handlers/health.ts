import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { healthBody } from '../lib/health.js';
import { json, requireEnv } from '../lib/http.js';

/** GET /api/health: the stage and media bucket this deployment serves. */
export async function handler(): Promise<APIGatewayProxyStructuredResultV2> {
  return json(200, healthBody(requireEnv('STAGE'), requireEnv('MEDIA_BUCKET')));
}
