import { randomUUID } from 'node:crypto';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { clientIp, ipBucket } from '../lib/client-ip.js';
import { effectiveLimits } from '../lib/events.js';
import { checkUploadAllowed, gateErrorStatus } from '../lib/gate.js';
import { gateDeps } from '../lib/gate-deps.js';
import { json, parseJsonBody, requireEnv } from '../lib/http.js';
import { rejectIfNotViaCloudFront } from '../lib/origin-guard.js';
import { getSecret } from '../lib/secrets.js';
import { verifySession } from '../lib/session.js';
import { ipHash, reservationUpdates, reserveQuota } from '../lib/quota.js';
import { loadSession } from '../lib/session-store.js';
import { uploadLimitsFromEnv } from '../lib/upload-limits.js';
import {
  objectKey,
  postConditions,
  PRESIGN_EXPIRES_SECONDS,
  validateUploadRequest,
} from '../lib/upload-policy.js';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const uploadLimits = uploadLimitsFromEnv(process.env);

/** POST /api/presign (Authorization: Bearer <session>) {filename, contentType, size, guestName?} */
export async function handler(
  event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded' | 'headers' | 'requestContext'>,
): Promise<APIGatewayProxyStructuredResultV2> {
  // 0. Only via CloudFront (so its WAF rate limit can't be bypassed).
  const denied = await rejectIfNotViaCloudFront(event);
  if (denied) return denied;

  // 1. Session: signature/expiry first (no I/O beyond the cached key), then the stored record.
  if (!event.headers?.authorization) return json(401, { error: 'session-required' });
  const sessionKey = await getSecret(requireEnv('SESSION_KEY_PARAM'));
  const check = verifySession(event.headers.authorization, sessionKey, gateDeps.now());
  if (!check.ok) return json(401, { error: check.error.kind });
  const session = await loadSession(check.value.id);
  if (!session) return json(401, { error: 'invalid-session' });

  // 2. Request shape.
  const body = parseJsonBody(event);
  if (!body) return json(400, { error: 'body must be valid JSON' });
  const validation = validateUploadRequest(body, uploadLimits.maxFileBytes);
  if (!validation.ok) return json(400, { error: validation.error.message });
  const req = validation.value;

  // 3. Event still open and uploads still enabled (PIN was verified when the session was issued).
  const gate = await checkUploadAllowed(
    { eventToken: session.eventToken, pin: undefined },
    gateDeps,
    { pinAlreadyVerified: true },
  );
  if (!gate.ok) return json(gateErrorStatus(gate.error), { error: gate.error.kind });
  const gateEvent = gate.value;

  // 4. Quotas: event, IP-hour and session counters, each reserved by a conditional update and
  //    rolled back if a later one is full (429 naming the full counter).
  const { ip } = clientIp(
    event.headers,
    event.requestContext?.http?.sourceIp ?? '',
    await getSecret(requireEnv('ORIGIN_VERIFY_PARAM')),
  );
  const reservation = reservationUpdates({
    tableName: requireEnv('TABLE_NAME'),
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
    eventId: gateEvent.eventId,
    ipHash: ipHash(ipBucket(ip), sessionKey),
    size: req.size,
    now: gateDeps.now(),
    limits: effectiveLimits(gateEvent.limits, uploadLimits.defaults),
  });
  if (!reservation.ok) return json(429, { error: reservation.error.kind });
  const reserved = await reserveQuota(reservation.value, (input) =>
    ddb.send(new UpdateItemCommand(input)),
  );
  if (!reserved.ok) {
    console.log(
      JSON.stringify({
        result: 'quota-exceeded',
        quota: reserved.error.kind,
        eventId: gateEvent.eventId,
      }),
    );
    return json(429, { error: reserved.error.kind });
  }

  const key = objectKey(gateEvent.eventId, req.guestSlug, randomUUID(), req.contentType);
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: requireEnv('MEDIA_BUCKET'),
    Key: key,
    Conditions: postConditions(req),
    Fields: { 'Content-Type': req.contentType },
    Expires: PRESIGN_EXPIRES_SECONDS,
  });

  return json(200, { url, fields, key });
}
