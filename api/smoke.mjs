// Loads each bundled handler exactly as Lambda does (ESM import, no global `require`) and invokes
// it with an event that is answered before any AWS call. Catches bundling problems that unit tests
// (which run from source) can't. Usage: npm run smoke --workspace api   (after npm run build)
process.env.STAGE ??= 'dev';
process.env.MEDIA_BUCKET ??= 'smoke-bucket';
process.env.TABLE_NAME ??= 'smoke-table';
process.env.UPLOADS_ENABLED_PARAM ??= '/shotparty/smoke/uploads_enabled';
process.env.SESSION_KEY_PARAM ??= '/shotparty/smoke/session_key';
process.env.TURNSTILE_SECRET_PARAM ??= '/shotparty/smoke/turnstile_secret';
process.env.ORIGIN_VERIFY_PARAM ??= '/shotparty/smoke/origin_verify';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'AKIASMOKETEST';
process.env.AWS_SECRET_ACCESS_KEY ??= 'smoke-secret';

const cases = {
  health: { event: {}, expect: (r) => r.statusCode === 200 },
  // Direct calls (no CloudFront origin header) are rejected before any SSM/DynamoDB lookup.
  presign: { event: { body: '{}', headers: {} }, expect: (r) => r.statusCode === 403 },
  session: { event: { body: '{}', headers: {} }, expect: (r) => r.statusCode === 403 },
  event: {
    event: { pathParameters: { token: 'x' }, headers: {} },
    expect: (r) => r.statusCode === 403,
  },
  // A non-upload key exercises import + event parsing without calling AWS.
  validate: {
    event: { detail: { bucket: { name: 'b' }, object: { key: 'accepted/x.jpg', size: 1 } } },
    expect: (r) => r.result === 'skipped',
  },
};

let failed = false;
for (const [name, { event, expect }] of Object.entries(cases)) {
  try {
    const { handler } = await import(`./dist/${name}/index.mjs`);
    const res = await handler(event);
    const ok = expect(res);
    failed ||= !ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} -> ${res.statusCode ?? res.result}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name} -> ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
