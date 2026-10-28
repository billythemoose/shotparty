import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  awsProfile,
  ConfigError,
  configEvent,
  loadConfig,
  names,
  parseConfig,
  REPO_ROOT,
  stageConfig,
} from '../lib/config.js';

const minimal = { stages: { prod: { turnstileSiteKey: '0x4AAAAAAAexample' } } };
const GIB = 1024 ** 3;

function problems(raw: unknown): string[] {
  try {
    parseConfig(raw);
  } catch (e: unknown) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('parseConfig', () => {
  it('accepts the checked-in example', () => {
    const config = loadConfig(join(REPO_ROOT, 'shotparty.config.example.json'));
    expect(config.budgets.accountMonthlyUsd).toBe(20);
  });

  it('fills in defaults', () => {
    const config = parseConfig(minimal);
    expect(config.aws).toEqual({
      profile: 'shotparty',
      region: 'us-east-1',
      prefix: 'shotparty',
    });
    expect(config.alerts).toEqual({});
    expect(config.budgets).toEqual({ accountMonthlyUsd: 20 });
    expect(config.download.outDir).toBe('photos');
    expect(config.stages.prod).toEqual({
      turnstileSiteKey: '0x4AAAAAAAexample',
      archiveAfterDays: 0,
      localDev: false,
    });
  });

  it('defaults localDev to true on dev only, and respects an explicit value', () => {
    const config = parseConfig({
      stages: { dev: { turnstileSiteKey: 'k' }, prod: { turnstileSiteKey: 'k', localDev: true } },
    });
    expect(config.stages.dev?.localDev).toBe(true);
    expect(config.stages.prod?.localDev).toBe(true);
  });

  it('reports every problem at once, with readable paths', () => {
    const found = problems({
      aws: { prefix: 'Bad_Prefix', regoin: 'us-east-1' },
      alerts: { email: 'not-an-email' },
      stages: { prod: { archiveAfterDays: -1 }, staging: {} },
    });
    expect(found).toEqual(
      expect.arrayContaining([
        'aws: unknown setting "regoin"',
        expect.stringMatching(/^aws\.prefix: must match pattern/),
        expect.stringMatching(/^alerts\.email: must match format "email"/),
        'stages: unknown setting "staging"',
        'stages.prod: missing "turnstileSiteKey" (or set cloudflare.accountId so setup creates the widget)',
        'stages.prod.archiveAfterDays: must be >= 0',
      ]),
    );
    expect(found).toHaveLength(6);
  });

  it('lets setup create the site key when the cloudflare section is set', () => {
    const accountId = '0123456789abcdef0123456789abcdef';
    const config = parseConfig({ cloudflare: { accountId }, stages: { prod: {} } });
    expect(config.cloudflare).toEqual({ accountId });
    expect(config.stages.prod).not.toHaveProperty('turnstileSiteKey');
    expect(problems({ cloudflare: { accountId: 'nope' }, stages: { prod: {} } })).toEqual([
      expect.stringMatching(/^cloudflare\.accountId: must match pattern/),
    ]);
  });

  it('requires at least one stage', () => {
    expect(problems({})).toEqual(['(top level): missing "stages"']);
    expect(problems({ stages: {} })).toEqual([
      expect.stringMatching(/^stages: must NOT have fewer/),
    ]);
  });

  it('explains that accountBudget was replaced', () => {
    expect(problems({ stages: { dev: { turnstileSiteKey: 'k', accountBudget: true } } })).toEqual([
      expect.stringMatching(
        /^stages\.dev: "accountBudget" was replaced by budgets\.accountMonthlyUsd/,
      ),
    ]);
  });
});

describe('budgets', () => {
  it('takes the account limit from the config, with 0 meaning no budget', () => {
    const config = parseConfig({
      budgets: { accountMonthlyUsd: 0 },
      stages: { dev: { turnstileSiteKey: 'k' } },
    });
    expect(config.budgets.accountMonthlyUsd).toBe(0);
  });

  it('rejects a negative limit', () => {
    expect(
      problems({ budgets: { accountMonthlyUsd: -1 }, stages: { prod: { turnstileSiteKey: 'k' } } }),
    ).toEqual(['budgets.accountMonthlyUsd: must be >= 0']);
  });
});

describe('uploads', () => {
  it('defaults to 1 GiB per file and 500 files / 10 GiB per session', () => {
    expect(parseConfig(minimal).uploads).toEqual({
      maxFileBytes: GIB,
      sessionFiles: 500,
      sessionBytes: 10 * GIB,
    });
  });

  it('converts GiB to bytes', () => {
    const config = parseConfig({
      ...minimal,
      uploads: { maxFileGb: 0.5, sessionFiles: 2000, sessionGb: 60 },
    });
    expect(config.uploads).toEqual({
      maxFileBytes: GIB / 2,
      sessionFiles: 2000,
      sessionBytes: 60 * GIB,
    });
  });

  it('rejects out-of-range limits', () => {
    expect(
      problems({ ...minimal, uploads: { maxFileGb: 6, sessionFiles: 0, sessionGb: 20 } }),
    ).toEqual(['uploads.maxFileGb: must be <= 5', 'uploads.sessionFiles: must be >= 1']);
    expect(problems({ ...minimal, uploads: { sessionGb: 0 } })).toContain(
      'uploads.sessionGb: must be > 0',
    );
  });

  it('rejects a session limit below the per-file cap', () => {
    expect(problems({ ...minimal, uploads: { maxFileGb: 2, sessionGb: 1 } })).toEqual([
      'uploads.sessionGb (1) is below maxFileGb (2), so the largest files could never be uploaded',
    ]);
    expect(problems({ ...minimal, uploads: { sessionGb: 0.5 } })).toHaveLength(1);
  });
});

describe('events', () => {
  const party = { name: 'Summer Party', eventId: 'summer-party-2026' };

  it('defaults to no events, and to no PIN for an event', () => {
    expect(parseConfig(minimal).events).toEqual([]);
    expect(parseConfig({ ...minimal, events: [party] }).events).toEqual([
      { ...party, pin: 'none', stage: 'prod' },
    ]);
  });

  it('validates each event and reports every problem', () => {
    const found = problems({
      ...minimal,
      events: [
        { ...party, eventId: 'Summer Party', accentColor: 'blue', openFrom: 'tomorrow' },
        { name: 'x', eventId: 'x', headline: 'h'.repeat(81), pin: 'sometimes' },
      ],
    });
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^events\.0\.eventId: must match pattern/),
        expect.stringMatching(/^events\.0\.accentColor: must match pattern/),
        expect.stringMatching(/^events\.0\.openFrom: must match format "date-time"/),
        expect.stringMatching(/^events\.1\.headline: must NOT have more than 80/),
        expect.stringMatching(/^events\.1\.pin: must be equal to one of/),
      ]),
    );
  });

  it('rejects a duplicate eventId and a window that ends before it starts', () => {
    expect(
      problems({
        ...minimal,
        events: [
          party,
          {
            ...party,
            name: 'Again',
            openFrom: '2026-07-18T16:00:00-07:00',
            openUntil: '2026-07-01T00:00:00-07:00',
          },
        ],
      }),
    ).toEqual([
      'events.1.eventId: "summer-party-2026" is used twice',
      'events.1: openUntil must be after openFrom',
    ]);
  });

  it('defaults an event to dev when only dev is defined, and rejects an undefined stage', () => {
    const devOnly = { stages: { dev: { turnstileSiteKey: 'k' } } };
    expect(parseConfig({ ...devOnly, events: [party] }).events[0]?.stage).toBe('dev');
    expect(problems({ ...devOnly, events: [{ ...party, stage: 'prod' }] })).toEqual([
      'events.0.stage: "prod" is not defined in stages',
    ]);
  });

  it('lists cross-field problems together with schema errors (Stage 17 gap)', () => {
    expect(
      problems({
        aws: { prefix: 'Bad_Prefix' },
        stages: {
          dev: { turnstileSiteKey: 'k' },
          prod: { turnstileSiteKey: 'k' },
        },
        uploads: { maxFileGb: 2, sessionGb: 1 },
        events: [party, { ...party, name: 'Again' }],
      }),
    ).toEqual([
      expect.stringMatching(/^aws\.prefix: must match pattern/),
      expect.stringContaining('uploads.sessionGb (1) is below maxFileGb (2)'),
      'events.1.eventId: "summer-party-2026" is used twice',
    ]);
  });

  it('survives a config whose shape is completely wrong', () => {
    expect(problems({ stages: 'yes', events: 'no' })).toEqual([
      expect.stringMatching(/^stages: must be object/),
      expect.stringMatching(/^events: must be array/),
    ]);
    expect(problems(null)).toEqual([expect.stringMatching(/must be object/)]);
  });

  it('finds an event by eventId, listing the known ones when it is missing', () => {
    const config = parseConfig({ ...minimal, events: [party] });
    expect(configEvent(config, 'summer-party-2026').name).toBe('Summer Party');
    expect(() => configEvent(config, 'nope')).toThrow(/defined: summer-party-2026/);
  });
});

describe('loadConfig', () => {
  it('explains a missing file', () => {
    expect(() => loadConfig('/nonexistent/shotparty.config.json')).toThrow(
      /Copy shotparty\.config\.example\.json/,
    );
  });

  it('explains invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shotparty-config-'));
    const path = join(dir, 'shotparty.config.json');
    await writeFile(path, '{ "stages": ');
    expect(() => loadConfig(path)).toThrow(/is not valid JSON/);
  });
});

describe('helpers', () => {
  const config = parseConfig({ ...minimal, aws: { prefix: 'party', profile: 'cfg' } });

  it('derives every AWS name from the prefix and stage', () => {
    const n = names(config, 'prod');
    expect(n.dataStack).toBe('party-prod-data');
    expect(n.appStack).toBe('party-prod-app');
    expect(n.param('tableName')).toBe('/party/prod/tableName');
    expect(n.alertEmailParam).toBe('/party/alert_email');
  });

  it('picks the profile: flag, then SHOTPARTY_PROFILE, then config', () => {
    const saved = process.env.SHOTPARTY_PROFILE;
    try {
      delete process.env.SHOTPARTY_PROFILE;
      expect(awsProfile(config)).toBe('cfg');
      process.env.SHOTPARTY_PROFILE = 'env';
      expect(awsProfile(config)).toBe('env');
      expect(awsProfile(config, 'flag')).toBe('flag');
    } finally {
      if (saved === undefined) {
        delete process.env.SHOTPARTY_PROFILE;
      } else {
        process.env.SHOTPARTY_PROFILE = saved;
      }
    }
  });

  it('refuses a stage the config does not define', () => {
    expect(() => stageConfig(config, 'dev')).toThrow(/stage "dev" is not defined/);
  });
});
