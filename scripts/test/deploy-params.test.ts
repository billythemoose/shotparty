import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config.js';
import { deployParams, shellQuote } from '../lib/deploy-params.js';

const config = parseConfig({
  stages: {
    dev: { turnstileSiteKey: '1x00000000000000000000BB', accountBudget: true },
    prod: { turnstileSiteKey: '0x4AAAAAAAexample', archiveAfterDays: 30 },
  },
});
const live = {
  siteUrl: 'https://d111example.cloudfront.net',
  webAclArn: 'arn:aws:wafv2:us-east-1:111122223333:global/webacl/CreatedByCloudFront-x/y',
};

describe('deployParams', () => {
  // These reproduce the hand-written samconfig.toml values the project shipped with.
  it('builds the dev data stack arguments, including the local dev origin', () => {
    expect(deployParams(config, 'dev', 'data', live)).toEqual({
      stackName: 'shotparty-dev-data',
      parameterOverrides: [
        'Stage=dev',
        'Prefix=shotparty',
        'AllowedOrigins=https://d111example.cloudfront.net,http://localhost:5173',
        'ArchiveAfterDays=0',
      ],
      tags: ['project=shotparty', 'stage=dev'],
      warnings: [],
    });
  });

  it('builds the prod app stack arguments, with no local hostnames', () => {
    expect(deployParams(config, 'prod', 'app', live).parameterOverrides).toEqual([
      'Stage=prod',
      'Prefix=shotparty',
      'MediaBucketName=/shotparty/prod/mediaBucketName',
      'TableName=/shotparty/prod/tableName',
      'TurnstileSiteKey=0x4AAAAAAAexample',
      'TurnstileHostnames=d111example.cloudfront.net',
      `WebAclArn=${live.webAclArn}`,
      'AccountBudget=false',
      'MaxUploadBytes=1073741824',
      'DefaultSessionFiles=500',
      'DefaultSessionBytes=10737418240',
    ]);
  });

  it('passes the upload limits to the app stack', () => {
    const raw = parseConfig({
      stages: { prod: { turnstileSiteKey: '0x4AAAAAAAexample' } },
      uploads: { maxFileGb: 2, sessionFiles: 1500, sessionGb: 40 },
    });
    expect(deployParams(raw, 'prod', 'app', live).parameterOverrides).toEqual(
      expect.arrayContaining([
        'MaxUploadBytes=2147483648',
        'DefaultSessionFiles=1500',
        'DefaultSessionBytes=42949672960',
      ]),
    );
  });

  it('uses the always-block test key until setup has created the widget', () => {
    const managed = parseConfig({
      cloudflare: { accountId: '0123456789abcdef0123456789abcdef' },
      stages: { prod: {} },
    });
    const app = deployParams(managed, 'prod', 'app', live);
    expect(app.parameterOverrides).toContain('TurnstileSiteKey=2x00000000000000000000AB');
    expect(app.warnings).toEqual([expect.stringMatching(/guests are refused/)]);
  });

  it('adds localhost to the dev Turnstile hostnames and creates the budget there', () => {
    const real = parseConfig({
      stages: { dev: { turnstileSiteKey: '0x4AAAAAAAexample', accountBudget: true } },
    });
    const p = deployParams(real, 'dev', 'app', live).parameterOverrides;
    expect(p).toContain('TurnstileHostnames=d111example.cloudfront.net,localhost');
    expect(p).toContain('AccountBudget=true');
  });

  it('turns the hostname check off for test keys, whose tokens report no real hostname', () => {
    const p = deployParams(config, 'dev', 'app', live).parameterOverrides;
    expect(p).toContain('TurnstileSiteKey=1x00000000000000000000BB');
    expect(p).toContain('TurnstileHostnames=""');
  });

  it('passes the archive setting to the data stack', () => {
    expect(deployParams(config, 'prod', 'data', live).parameterOverrides).toContain(
      'ArchiveAfterDays=30',
    );
  });

  it('works before the app stack exists, and says a second pass is needed', () => {
    const data = deployParams(config, 'prod', 'data', {});
    expect(data.parameterOverrides).toContain('AllowedOrigins=http://localhost:5173');
    expect(data.warnings).toEqual([expect.stringContaining('no site URL yet')]);
    const app = deployParams(config, 'prod', 'app', {});
    expect(app.parameterOverrides).toContain('TurnstileHostnames=""');
    expect(app.parameterOverrides).toContain('WebAclArn=""');
    expect(app.warnings).toHaveLength(1);
  });

  it('uses the configured prefix everywhere', () => {
    const party = parseConfig({
      aws: { prefix: 'party' },
      stages: { prod: { turnstileSiteKey: 'k' } },
    });
    const app = deployParams(party, 'prod', 'app', live);
    expect(app.stackName).toBe('party-prod-app');
    expect(app.tags).toEqual(['project=party', 'stage=prod']);
    expect(app.parameterOverrides).toContain('Prefix=party');
    expect(app.parameterOverrides).toContain('TableName=/party/prod/tableName');
  });
});

describe('shellQuote', () => {
  it('round-trips awkward values through bash', () => {
    const value = `it's $HOME "quoted" \`cmd\``;
    const out = execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`], {
      encoding: 'utf8',
    });
    expect(out).toBe(value);
  });
});
