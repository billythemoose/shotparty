/**
 * @fileoverview REHEARSAL: simulates many guests uploading at once through the real path
 * (CloudFront -> WAF -> presign -> S3 -> validator) and reports success, latency and validator lag.
 * Guests are named sim-guest-NN so their files can be removed afterwards with --cleanup.
 *
 *   npm run load-test -- --stage prod --event <token> --allow-prod [--guests 20] [--files 10] [--kb 300]
 *   npm run load-test -- --stage prod --event <token> --allow-prod --cleanup
 *
 * Sessions are minted (scripts/lib/mint.ts) because a script can't solve Turnstile.
 * Each guest uploads 3 files at a time, like the page does.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { assertIsError } from '../api/src/lib/result.js';
import { awsProfile, loadConfigOrExit, names } from './lib/config.js';
import { createMinter } from './lib/mint.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    event: { type: 'string' },
    guests: { type: 'string', default: '20' },
    files: { type: 'string', default: '10' },
    kb: { type: 'string', default: '300' },
    profile: { type: 'string' },
    'allow-prod': { type: 'boolean', default: false },
    cleanup: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const stage = opts.stage;
if (stage !== 'dev' && stage !== 'prod') fail('--stage must be dev or prod');
const guests = Number(opts.guests);
const filesPerGuest = Number(opts.files);
const kb = Number(opts.kb);
if (!(guests >= 1 && guests <= 50)) fail('--guests must be 1..50');
if (!(filesPerGuest >= 1 && filesPerGuest <= 50)) fail('--files must be 1..50');
if (!(kb >= 1 && kb <= 5000)) fail('--kb must be 1..5000');

const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config, opts.profile);
const region = config.aws.region;
const awsNames = names(config, stage);
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });
const cfn = new CloudFormationClient({ region });

const minter = await createMinter({
  config,
  stage,
  eventToken: opts.event ?? '',
  allowProd: opts['allow-prod'],
}).catch((e: unknown) => {
  assertIsError(e);
  return fail(e.message);
});
const eventId = minter.event.eventId;
const bucket =
  (await ssm.send(new GetParameterCommand({ Name: awsNames.param('mediaBucketName') }))).Parameter
    ?.Value ?? fail('no media bucket parameter');
function guestName(i: number): string {
  return `sim-guest-${String(i + 1).padStart(2, '0')}`;
}

if (opts.cleanup) {
  // Remove every version of every sim-guest object (uploads/ and accepted/) for this event.
  let removed = 0;
  for (const prefix of [`uploads/${eventId}/sim-guest-`, `accepted/${eventId}/sim-guest-`]) {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((v) =>
        v.Key && v.VersionId ? [{ Key: v.Key, VersionId: v.VersionId }] : [],
      );
      for (let i = 0; i < objects.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
          }),
        );
      }
      removed += objects.length;
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
  }
  console.log(`Removed ${removed} sim-guest object version(s) from ${stage} event ${eventId}.`);
  process.exit(0);
}

const site =
  (
    await cfn.send(new DescribeStacksCommand({ StackName: awsNames.appStack }))
  ).Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'SiteUrl')?.OutputValue ??
  fail('no SiteUrl output');

// A JPEG signature followed by random bytes: passes the validator's magic check.
const JPEG_HEAD = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
function fileBytes(): Buffer<ArrayBuffer> {
  return Buffer.concat([JPEG_HEAD, randomBytes(kb * 1024 - JPEG_HEAD.length)]);
}

/** How one simulated upload went. */
interface UploadTiming {
  presignMs: number;
  uploadMs: number;
  presignStatus: number;
  uploadStatus: number;
  error?: string;
}

function isPresignReply(value: unknown): value is { url: string; fields: Record<string, string> } {
  if (typeof value !== 'object' || value === null) return false;
  const { url, fields } = value as Record<string, unknown>; // a non-null object, checked above
  return (
    typeof url === 'string' &&
    typeof fields === 'object' &&
    fields !== null &&
    Object.values(fields).every((v) => typeof v === 'string')
  );
}

async function uploadOne(session: string, guest: string, n: number): Promise<UploadTiming> {
  const body = fileBytes();
  const t0 = performance.now();
  const res = await fetch(`${site}/api/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
    body: JSON.stringify({
      filename: `IMG_${n}.JPG`,
      contentType: 'image/jpeg',
      size: body.length,
      guestName: guest,
    }),
  });
  const presignMs = performance.now() - t0;
  if (!res.ok) {
    return {
      presignMs,
      uploadMs: 0,
      presignStatus: res.status,
      uploadStatus: 0,
      error: await res.text(),
    };
  }
  const reply: unknown = await res.json();
  if (!isPresignReply(reply)) {
    return {
      presignMs,
      uploadMs: 0,
      presignStatus: res.status,
      uploadStatus: 0,
      error: 'bad reply',
    };
  }
  const { url, fields } = reply;
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, v);
  }
  form.append('file', new Blob([body], { type: 'image/jpeg' }));
  const t1 = performance.now();
  const up = await fetch(url, { method: 'POST', body: form });
  return {
    presignMs,
    uploadMs: performance.now() - t1,
    presignStatus: res.status,
    uploadStatus: up.status,
    ...(up.ok ? {} : { error: (await up.text()).slice(0, 200) }),
  };
}

async function guestRun(i: number): Promise<UploadTiming[]> {
  const session = await minter.mint();
  const guest = guestName(i);
  const queue = Array.from({ length: filesPerGuest }, (_, n) => n + 1);
  const results: UploadTiming[] = [];
  await Promise.all(
    [0, 1, 2].map(async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        results.push(await uploadOne(session, guest, n));
      }
    }),
  );
  return results;
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0,
  );
}

const total = guests * filesPerGuest;
console.log(
  `==> ${guests} simulated guests x ${filesPerGuest} files x ${kb} KB = ${total} uploads ` +
    `(${((total * kb) / 1024).toFixed(1)} MB) -> ${site} (event ${eventId})`,
);
const started = performance.now();
const results = (await Promise.all(Array.from({ length: guests }, (_, i) => guestRun(i)))).flat();
const uploadSeconds = (performance.now() - started) / 1000;

const ok = results.filter((r) => r.presignStatus === 200 && r.uploadStatus === 204);
const statusCounts = results.reduce<Record<string, number>>((acc, r) => {
  const k = `presign ${r.presignStatus} / s3 ${r.uploadStatus || '-'}`;
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `==> uploads finished in ${uploadSeconds.toFixed(1)} s: ${ok.length}/${total} succeeded`,
);
console.log('    outcomes:', statusCounts);
console.log(
  `    presign ms p50/p95/max: ${pct(
    results.map((r) => r.presignMs),
    50,
  )}/` +
    `${pct(
      results.map((r) => r.presignMs),
      95,
    )}/${pct(
      results.map((r) => r.presignMs),
      100,
    )}` +
    `   upload ms p50/p95: ${pct(
      ok.map((r) => r.uploadMs),
      50,
    )}/${pct(
      ok.map((r) => r.uploadMs),
      95,
    )}`,
);
for (const r of results.filter((x) => x.error).slice(0, 3)) {
  console.log('    error sample:', r.error);
}

// Wait for the validator to move everything to accepted/.
async function countAccepted(): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `accepted/${eventId}/sim-guest-`,
        ContinuationToken: token,
      }),
    );
    count += page.KeyCount ?? 0;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return count;
}
const waitStart = performance.now();
let accepted = 0;
while (performance.now() - waitStart < 180_000) {
  accepted = await countAccepted();
  if (accepted >= ok.length) break;
  await new Promise((resolve) => {
    setTimeout(resolve, 3000);
  });
}
console.log(
  `==> validator: ${accepted}/${ok.length} in accepted/ ` +
    `${((performance.now() - waitStart) / 1000).toFixed(0)} s after the last upload finished`,
);
console.log(
  `    clean up: npm run load-test -- --stage ${stage} --event <token> --allow-prod --cleanup`,
);
process.exit(ok.length === total && accepted >= ok.length ? 0 : 1);
