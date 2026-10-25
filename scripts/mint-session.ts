/**
 * @fileoverview TEST HELPER: prints an upload session for an event without Turnstile (see
 * scripts/lib/mint.ts).
 *
 *   npm run -s session:mint -- --stage dev --event <eventToken>
 *   npm run -s session:mint -- --stage prod --event <eventToken> --allow-prod   (rehearsals only)
 */
import { parseArgs } from 'node:util';
import { assertIsError } from '../api/src/lib/result.js';
import { awsProfile, loadConfigOrExit } from './lib/config.js';
import { createMinter } from './lib/mint.js';

const { values: opts } = parseArgs({
  options: {
    stage: { type: 'string' },
    event: { type: 'string' },
    profile: { type: 'string' },
    'allow-prod': { type: 'boolean', default: false },
  },
});

if (opts.stage !== 'dev' && opts.stage !== 'prod') {
  console.error('error: --stage must be dev or prod');
  process.exit(1);
}
const config = loadConfigOrExit();
process.env.AWS_PROFILE = awsProfile(config, opts.profile);
try {
  const minter = await createMinter({
    config,
    stage: opts.stage,
    eventToken: opts.event ?? '',
    allowProd: opts['allow-prod'],
  });
  console.log(await minter.mint());
} catch (e: unknown) {
  assertIsError(e);
  console.error(`error: ${e.message}`);
  process.exit(1);
}
