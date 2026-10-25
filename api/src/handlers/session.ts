import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { clientIp } from '../lib/client-ip.js';
import { checkUploadAllowed, gateErrorStatus } from '../lib/gate.js';
import { gateDeps } from '../lib/gate-deps.js';
import { json, parseJsonBody, requireEnv } from '../lib/http.js';
import { rejectIfNotViaCloudFront } from '../lib/origin-guard.js';
import { getSecret } from '../lib/secrets.js';
import { issueSession } from '../lib/session.js';
import { saveSession } from '../lib/session-store.js';
import { describeTurnstileError, TURNSTILE_ACTION, verifyTurnstile } from '../lib/turnstile.js';

/**
 * POST /api/session {eventToken, pin?, turnstileToken} -> {session, expiresAt}
 * Turnstile is verified BEFORE the PIN, so every PIN guess costs a human-verification solve.
 */
export async function handler(
  event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded' | 'requestContext' | 'headers'>,
): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await rejectIfNotViaCloudFront(event);
  if (denied) return denied;

  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'body must be a JSON object' });
  const { eventToken, pin, turnstileToken } = body;

  const { ip } = clientIp(
    event.headers,
    event.requestContext?.http?.sourceIp ?? '',
    await getSecret(requireEnv('ORIGIN_VERIFY_PARAM')),
  );
  const human = await verifyTurnstile(
    {
      secret: await getSecret(requireEnv('TURNSTILE_SECRET_PARAM')),
      token: turnstileToken,
      remoteIp: ip || undefined,
    },
    {
      action: TURNSTILE_ACTION,
      hostnames: (process.env.TURNSTILE_HOSTNAMES ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    },
  );
  if (!human.ok) {
    console.log(
      JSON.stringify({ result: 'turnstile-failed', reason: describeTurnstileError(human.error) }),
    );
    return json(403, { error: 'verification-failed' });
  }

  const gate = await checkUploadAllowed({ eventToken, pin }, gateDeps);
  if (!gate.ok) return json(gateErrorStatus(gate.error), { error: gate.error.kind });
  const gateEvent = gate.value;

  const now = gateDeps.now();
  const { token, claims } = issueSession(await getSecret(requireEnv('SESSION_KEY_PARAM')), now);
  await saveSession({
    id: claims.id,
    eventToken: gateEvent.token,
    eventId: gateEvent.eventId,
    createdAt: now.toISOString(),
    expiresAt: claims.expiresAt,
  });
  console.log(JSON.stringify({ result: 'session-issued', eventId: gateEvent.eventId }));
  return json(200, { session: token, expiresAt: claims.expiresAt });
}
