/**
 * @fileoverview Writes the README's coverage badge from the last coverage run (line coverage).
 *
 *   npm run test:coverage && npm run coverage:badge
 *   npm run coverage:badge -- --check     (CI: warn when the committed badge is out of date)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { coverageBadgeSvg } from './lib/badge.js';

const BADGE = '.github/badges/coverage.svg';
const SUMMARY = 'coverage/coverage-summary.json';

const { values: opts } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

function field(value: unknown, key: string): unknown {
  // A non-null object, checked first; reading a missing key gives undefined.
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Returns total line coverage from vitest's json-summary report. */
function linePct(summary: unknown): number {
  const pct = field(field(field(summary, 'total'), 'lines'), 'pct');
  if (typeof pct !== 'number') throw new Error(`${SUMMARY} has no total.lines.pct`);
  return pct;
}

const pct = linePct(JSON.parse(await readFile(SUMMARY, 'utf8')));
const svg = coverageBadgeSvg(pct);

if (opts.check) {
  const committed = await readFile(BADGE, 'utf8').catch(() => '');
  if (committed !== svg) {
    // A warning, not a failure: a stale badge shouldn't block a change.
    console.log(
      `::warning file=${BADGE}::Coverage badge is out of date (now ${pct}%). Run npm run coverage:badge.`,
    );
  } else {
    console.log(`Coverage badge is current (${pct}%).`);
  }
} else {
  await mkdir('.github/badges', { recursive: true });
  await writeFile(BADGE, svg);
  console.log(`Wrote ${BADGE} (${pct}% lines).`);
}
