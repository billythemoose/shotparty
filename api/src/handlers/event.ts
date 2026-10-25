import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { TOKEN_PATTERN, windowStatus } from '../lib/events.js';
import { gateDeps } from '../lib/gate-deps.js';
import { json } from '../lib/http.js';
import { rejectIfNotViaCloudFront } from '../lib/origin-guard.js';

/**
 * GET /api/event/{token}: what the guest page needs to render (name, the event's own text and
 * color, PIN prompt, open/closed).
 */
export async function handler(
  event: Pick<APIGatewayProxyEventV2, 'pathParameters' | 'headers' | 'requestContext'>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await rejectIfNotViaCloudFront(event);
  if (denied) return denied;

  const token = event.pathParameters?.token ?? '';
  if (!TOKEN_PATTERN.test(token)) return json(404, { error: 'unknown-event' });

  const record = await gateDeps.getEvent(token);
  if (!record) return json(404, { error: 'unknown-event' });

  return json(200, {
    name: record.name,
    display: record.display ?? {},
    requiresPin: Boolean(record.pinHash),
    status: windowStatus(record, gateDeps.now()),
    openFrom: record.openFrom,
    openUntil: record.openUntil,
    uploadsEnabled: await gateDeps.uploadsEnabled(),
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY ?? '',
  });
}
