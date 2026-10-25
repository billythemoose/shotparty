/**
 * @fileoverview Builds a private, local gallery page for an event's accepted uploads.
 *
 *   npm run gallery -- --stage dev                      (lists event folders)
 *   npm run gallery -- --stage dev --event stage-8-test-2026 [--hours 6] [--out galleries]
 *
 * Files load through temporary presigned GET URLs signed with YOUR AWS login, so nothing is made
 * public and nothing new is hosted. Links stop working after --hours, or earlier when your AWS
 * login session ends (SSO: up to 8 h), then just run it again. Output lands in galleries/
 * (git-ignored): treat it like the photos themselves while the links are valid.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { EVENT_ID_PATTERN } from '../api/src/lib/events.js';
import { awsProfile, loadConfigOrExit, names } from './lib/config.js';
import { downloadName, type GalleryItem, guestOf, renderGallery } from './lib/gallery.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    event: { type: 'string' },
    hours: { type: 'string', default: '6' },
    out: { type: 'string', default: 'galleries' },
    profile: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const stage = opts.stage;
if (stage !== 'dev' && stage !== 'prod') fail('--stage must be dev or prod');
const hours = Number(opts.hours);
if (!(hours > 0 && hours <= 12)) fail('--hours must be between 0 and 12');

const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config, opts.profile);
const region = config.aws.region;
const awsNames = names(config, stage);
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });

const bucket = (
  await ssm.send(new GetParameterCommand({ Name: awsNames.param('mediaBucketName') }))
).Parameter?.Value;
if (!bucket) fail(`no ${awsNames.param('mediaBucketName')} (is the data stack deployed?)`);

if (!opts.event) {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: 'accepted/', Delimiter: '/' }),
  );
  // accepted/<event>/ -> <event>
  const events = (res.CommonPrefixes ?? []).flatMap((p) => p.Prefix?.split('/')[1] || []);
  console.log(
    events.length
      ? `Event folders in ${stage}:\n  ${events.join('\n  ')}\n\nnpm run gallery -- --stage ${stage} --event <folder>`
      : `No accepted uploads in ${stage} yet.`,
  );
  process.exit(0);
}

const eventId = opts.event;
if (!EVENT_ID_PATTERN.test(eventId)) fail(`--event "${eventId}" is not a valid event folder name`);

// List every accepted object for the event (paginated).
interface ListedObject {
  Key: string;
  Size: number;
  LastModified: Date;
}
const objects: ListedObject[] = [];
let token: string | undefined;
do {
  const page = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `accepted/${eventId}/`,
      ContinuationToken: token,
    }),
  );
  for (const o of page.Contents ?? []) {
    if (o.Key && o.Size !== undefined && o.LastModified) {
      objects.push({ Key: o.Key, Size: o.Size, LastModified: o.LastModified });
    }
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

// Presigned URLs die with the credentials that signed them, so report the earlier of the two.
const now = new Date();
const creds = await s3.config.credentials();
const requested = new Date(now.getTime() + hours * 3_600_000);
const linksExpireAt =
  creds.expiration && creds.expiration < requested ? creds.expiration : requested;
const expiresIn = Math.floor(hours * 3600);

const items: GalleryItem[] = await Promise.all(
  objects.map(async (o) => {
    const base = { key: o.Key, guest: guestOf(o.Key), uploadedAt: o.LastModified };
    return {
      ...base,
      size: o.Size,
      viewUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: o.Key }), {
        expiresIn,
      }),
      downloadUrl: await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: o.Key,
          ResponseContentDisposition: `attachment; filename="${downloadName(base)}"`,
        }),
        { expiresIn },
      ),
    };
  }),
);

await mkdir(opts.out, { recursive: true });
const file = join(opts.out, `${eventId}-${stage}.html`);
await writeFile(file, renderGallery(items, { eventId, stage, generatedAt: now, linksExpireAt }));
console.log(
  `Gallery: ${resolve(file)}\n  ${items.length} file(s); links valid until ${linksExpireAt.toISOString()}\n  open "${file}"`,
);
