import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';
import { requireEnv } from '../lib/http.js';
import { err, ok } from '../lib/result.js';
import { type Outcome, type ValidateDeps, validateUpload } from '../lib/validate-upload.js';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const REJECTION_TTL_DAYS = 90;

interface ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string; size: number; 'version-id'?: string };
}

// S3 -> EventBridge delivers keys URL-encoded ("+" for spaces), like classic S3 notifications.
function decodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

function encodeCopySource(bucket: string, key: string, versionId?: string): string {
  const path = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const version = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
  return `${bucket}/${path}${version}`;
}

const deps: ValidateDeps = {
  async readHead(obj, bytes) {
    try {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: obj.bucket,
          Key: obj.key,
          VersionId: obj.versionId,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      const head = (await res.Body?.transformToByteArray()) ?? new Uint8Array();
      // A ranged GET still reports the whole object's ETag.
      return { bytes: head, etag: res.ETag ?? '' };
    } catch (e: unknown) {
      if (e instanceof NoSuchKey) return null;
      if (e instanceof S3ServiceException && e.name === 'NoSuchVersion') return null;
      throw e;
    }
  },
  async claimContent(claim) {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: requireEnv('TABLE_NAME'),
          Item: {
            pk: { S: `CONTENT#${claim.eventId}` },
            sk: { S: `${claim.guest}#${claim.md5}` },
            destKey: { S: claim.destKey },
            at: { S: claim.at },
          },
          // A redelivery of the upload that made the claim must not count as its own duplicate.
          ConditionExpression: 'attribute_not_exists(pk) OR destKey = :destKey',
          ExpressionAttributeValues: { ':destKey': { S: claim.destKey } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return ok(undefined);
    } catch (e: unknown) {
      if (e instanceof ConditionalCheckFailedException) {
        return err({ kind: 'duplicate', existingKey: e.Item?.destKey?.S ?? 'unknown' });
      }
      throw e;
    }
  },
  async copy(obj, destKey) {
    await s3.send(
      new CopyObjectCommand({
        Bucket: obj.bucket,
        Key: destKey,
        CopySource: encodeCopySource(obj.bucket, obj.key, obj.versionId),
        MetadataDirective: 'COPY',
      }),
    );
  },
  async deleteVersion(obj) {
    await s3.send(
      new DeleteObjectCommand({ Bucket: obj.bucket, Key: obj.key, VersionId: obj.versionId }),
    );
  },
  async recordRejection(r) {
    const ttl = Math.floor(Date.parse(r.at) / 1000) + REJECTION_TTL_DAYS * 86400;
    await ddb.send(
      new PutItemCommand({
        TableName: requireEnv('TABLE_NAME'),
        Item: {
          pk: { S: `REJECT#${r.eventId}` },
          sk: { S: `${r.at}#${r.key}` },
          guest: { S: r.guest },
          key: { S: r.key },
          size: { N: String(r.size) },
          reason: { S: r.reason },
          headHex: { S: r.headHex },
          ttl: { N: String(ttl) },
        },
      }),
    );
  },
  log: (entry) => {
    console.log(JSON.stringify(entry));
  },
  now: () => new Date(),
};

/** EventBridge "Object Created" on the media bucket: accepts or rejects the new upload. */
export async function handler(
  event: Pick<EventBridgeEvent<'Object Created', ObjectCreatedDetail>, 'detail'>,
): Promise<Outcome> {
  const { bucket, object } = event.detail;
  return validateUpload(
    {
      bucket: bucket.name,
      key: decodeKey(object.key),
      versionId: object['version-id'],
      size: object.size,
    },
    deps,
  );
}
