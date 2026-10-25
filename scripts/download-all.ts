/**
 * @fileoverview Downloads every accepted upload for an event to your computer, with readable names,
 * a manifest, and an MD5 check of each file against S3. Safe to re-run: files already present and
 * verified are skipped, so an interrupted download just resumes.
 *
 *   npm run download -- --stage prod --event test-event-2026 [--out photos]
 *
 * Result: photos/<stage>/<event>/<guest>/<guest>_<yyyy-mm-dd_hh-mm-ss>_<id>.<ext> + manifest.csv
 * (photos/ is git-ignored).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { EVENT_ID_PATTERN } from '../api/src/lib/events.js';
import {
  manifestCsv,
  type PlannedFile,
  planDownload,
  type StoredObject,
  verifyFile,
} from './lib/download.js';
import { awsProfile, loadConfigOrExit, names } from './lib/config.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    event: { type: 'string' },
    out: { type: 'string' },
    profile: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const stage = opts.stage;
if (stage !== 'dev' && stage !== 'prod') fail('--stage must be dev or prod');
const eventId = opts.event ?? fail('--event <event folder> is required (see npm run gallery)');
if (!EVENT_ID_PATTERN.test(eventId)) fail(`--event "${eventId}" is not a valid event folder name`);

const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config, opts.profile);
const region = config.aws.region;
const awsNames = names(config, stage);
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });
const bucket =
  (await ssm.send(new GetParameterCommand({ Name: awsNames.param('mediaBucketName') }))).Parameter
    ?.Value ?? fail('no media bucket parameter');

// 1. List what S3 has.
const objects: StoredObject[] = [];
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
    if (o.Key && o.Size !== undefined && o.ETag && o.LastModified) {
      objects.push({ key: o.Key, size: o.Size, etag: o.ETag, lastModified: o.LastModified });
    }
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
if (objects.length === 0) fail(`no accepted uploads for ${eventId} in ${stage}`);

const root = join(opts.out ?? config.download.outDir, stage, eventId);
const plan = planDownload(objects);
const totalBytes = plan.reduce((s, f) => s + f.size, 0);
console.log(
  `==> ${plan.length} file(s), ${(totalBytes / 1024 ** 2).toFixed(1)} MB -> ${resolve(root)}`,
);

async function localInfo(path: string): Promise<{ size: number; md5: string } | null> {
  try {
    const { size } = await stat(path);
    const hash = createHash('md5');
    await pipeline(createReadStream(path), hash);
    return { size, md5: hash.digest('hex') };
  } catch {
    return null;
  }
}

// 2. Download what's missing or wrong (8 at a time), via a temp file so a crash never leaves a
//    truncated file that looks complete.
let downloaded = 0;
let skipped = 0;
const queue = [...plan];
async function worker(): Promise<void> {
  for (let f: PlannedFile | undefined = queue.shift(); f; f = queue.shift()) {
    const path = join(root, f.relativePath);
    if (verifyFile(f, await localInfo(path)) === 'ok') {
      skipped++;
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: f.key }));
    const tmp = `${path}.part`;
    // In Node, the SDK returns GetObject bodies as Readable streams.
    await pipeline(res.Body as Readable, createWriteStream(tmp));
    await rename(tmp, path);
    downloaded++;
    if ((downloaded + skipped) % 25 === 0) {
      console.log(`    ${downloaded + skipped}/${plan.length}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, () => worker()));

// 3. Verify everything and write the manifest.
const problems: string[] = [];
let md5Checked = 0;
for (const f of plan) {
  const verdict = verifyFile(f, await localInfo(join(root, f.relativePath)));
  if (verdict !== 'ok') {
    problems.push(`${verdict}: ${f.relativePath}`);
  } else if (f.md5) {
    md5Checked++;
  }
}
await writeFile(join(root, 'manifest.csv'), manifestCsv(plan));

const guests = new Set(plan.map((f) => f.guest)).size;
console.log(
  `==> downloaded ${downloaded}, already present ${skipped}; ${guests} guest folder(s); manifest.csv written`,
);
console.log(
  `==> verified ${plan.length - problems.length}/${plan.length} (size), ${md5Checked} by MD5 against S3`,
);
if (problems.length) {
  for (const p of problems.slice(0, 10)) {
    console.log(`    ${p}`);
  }
  fail(`${problems.length} file(s) failed verification; re-run to retry`);
}
console.log(`    open "${root}"`);
