import { describe, expect, it } from 'vitest';
import { type ResourceChange, riskyChanges } from '../lib/changeset-guard.js';
import { parseConfig } from '../lib/config.js';
import {
  configFromAnswers,
  stagesFromChoice,
  isTestSiteKey,
  majorVersion,
  parseCreateOutput,
  TEST_SITE_KEY,
  type WizardAnswers,
} from '../lib/setup.js';

describe('riskyChanges', () => {
  const change = (
    id: string,
    type: string,
    action: string,
    replacement = 'False',
  ): ResourceChange => ({
    LogicalResourceId: id,
    ResourceType: type,
    Action: action,
    Replacement: replacement,
  });

  it('allows in-place updates, including the ones seen on the real prod app stack', () => {
    expect(
      riskyChanges('app', [
        change('PresignFunction', 'AWS::Lambda::Function', 'Modify'),
        change('HttpApi', 'AWS::ApiGatewayV2::Api', 'Modify'),
        change(
          'ValidateFunctionUploadCreatedPermission',
          'AWS::Lambda::Permission',
          'Modify',
          'Conditional',
        ),
        change('Distribution', 'AWS::CloudFront::Distribution', 'Modify'),
      ]),
    ).toEqual([]);
    expect(riskyChanges('data', [change('MediaBucket', 'AWS::S3::Bucket', 'Modify')])).toEqual([]);
  });

  it('refuses any replacement or deletion in the data stack', () => {
    expect(
      riskyChanges('data', [
        change('MediaBucket', 'AWS::S3::Bucket', 'Modify', 'True'),
        change('Table', 'AWS::DynamoDB::Table', 'Modify', 'Conditional'),
        change('TableNameParam', 'AWS::SSM::Parameter', 'Remove'),
      ]),
    ).toEqual([
      'MediaBucket (AWS::S3::Bucket) would be replaced',
      'Table (AWS::DynamoDB::Table) might be replaced',
      'TableNameParam (AWS::SSM::Parameter) would be deleted',
    ]);
  });

  it('refuses replacing the distribution (printed QR codes depend on its URL), nothing else in app', () => {
    expect(
      riskyChanges('app', [
        change('Distribution', 'AWS::CloudFront::Distribution', 'Modify', 'True'),
        change('SessionFunction', 'AWS::Lambda::Function', 'Modify', 'True'),
      ]),
    ).toEqual(['Distribution (AWS::CloudFront::Distribution) would be replaced']);
  });

  it('allows creating a brand-new stack', () => {
    expect(riskyChanges('data', [change('MediaBucket', 'AWS::S3::Bucket', 'Add')])).toEqual([]);
  });

  it('lets the old budget leave the app stack and the account stack change freely', () => {
    expect(
      riskyChanges('app', [change('MonthlyBudget', 'AWS::Budgets::Budget', 'Remove')]),
    ).toEqual([]);
    expect(
      riskyChanges('account', [
        change('AccountBudget', 'AWS::Budgets::Budget', 'Remove'),
        change('Placeholder', 'AWS::CloudFormation::WaitConditionHandle', 'Add'),
      ]),
    ).toEqual([]);
  });
});

describe('setup helpers', () => {
  it('recognizes Cloudflare test site keys only', () => {
    expect(isTestSiteKey('1x00000000000000000000AA')).toBe(true);
    expect(isTestSiteKey('1x00000000000000000000BB')).toBe(true);
    expect(isTestSiteKey('3x00000000000000000000FF')).toBe(true);
    expect(isTestSiteKey('0x4AAAAAAAexample')).toBe(false);
  });

  it('reads major versions', () => {
    expect(majorVersion('v22.19.0')).toBe(22);
    expect(majorVersion('22\n')).toBe(22);
    expect(majorVersion('lts/*')).toBeNaN();
  });

  it('pulls the guest URL and PIN out of event:create output', () => {
    const out = '  PIN:       482913\n  Guest URL: https://d1.cloudfront.net/e/AbC_dEf\n';
    expect(parseCreateOutput(out)).toEqual({
      guestUrl: 'https://d1.cloudfront.net/e/AbC_dEf',
      pin: '482913',
    });
    expect(parseCreateOutput('  PIN:       (none)\n')).toEqual({});
  });
});

describe('stagesFromChoice', () => {
  it('maps each answer to its stages', () => {
    expect(stagesFromChoice('prod')).toEqual(['prod']);
    expect(stagesFromChoice('Dev')).toEqual(['dev']);
    expect(stagesFromChoice('both')).toEqual(['dev', 'prod']);
    expect(stagesFromChoice('staging')).toBeNull();
  });
});

describe('configFromAnswers', () => {
  const base: WizardAnswers = {
    profile: 'default',
    region: 'us-east-1',
    prefix: 'shotparty',
    email: 'me@example.com',
    stages: ['prod'],
    siteKeys: { prod: '0x4AAAAAAAexample' },
  };

  it('writes a valid config with the default account budget', () => {
    const raw = configFromAnswers(base);
    const config = parseConfig(raw);
    expect(config.stages.prod).toMatchObject({ turnstileSiteKey: '0x4AAAAAAAexample' });
    expect(config.budgets.accountMonthlyUsd).toBe(20);
    expect(config.alerts.email).toBe('me@example.com');
    expect(raw).not.toHaveProperty('events');
  });

  it('puts the first event on dev when dev is the only stage', () => {
    const config = parseConfig(
      configFromAnswers({
        ...base,
        stages: ['dev'],
        siteKeys: {},
        event: { name: 'Try Out', openFrom: '2027-03-01T18:00:00-08:00', pin: false },
      }),
    );
    expect(Object.keys(config.stages)).toEqual(['dev']);
    expect(config.stages.dev).toMatchObject({ turnstileSiteKey: TEST_SITE_KEY });
    expect(config.events[0]).toMatchObject({ eventId: 'try-out-2027', stage: 'dev' });
  });

  it('uses the test key for a blank dev key', () => {
    const config = parseConfig(configFromAnswers({ ...base, stages: ['dev', 'prod'] }));
    expect(config.stages.dev).toMatchObject({ turnstileSiteKey: TEST_SITE_KEY });
  });

  it('leaves the prod key out for setup to create when a Cloudflare account is given', () => {
    const accountId = '0123456789abcdef0123456789abcdef';
    const raw = configFromAnswers({
      ...base,
      stages: ['dev', 'prod'],
      cloudflareAccountId: accountId,
      siteKeys: { dev: TEST_SITE_KEY },
    });
    const config = parseConfig(raw);
    expect(config.cloudflare).toEqual({ accountId });
    expect(config.stages.dev?.turnstileSiteKey).toBe(TEST_SITE_KEY);
    expect(config.stages.prod).not.toHaveProperty('turnstileSiteKey');
  });

  it('adds the first event on prod, deriving its folder name and leaving blanks out', () => {
    const config = parseConfig(
      configFromAnswers({
        ...base,
        stages: ['dev', 'prod'],
        event: {
          name: 'Launch Night',
          openFrom: '2027-03-01T18:00:00-08:00',
          pin: true,
          headline: 'Say cheese',
          accentColor: '#1a5fb4',
        },
      }),
    );
    expect(config.events).toEqual([
      {
        name: 'Launch Night',
        eventId: 'launch-night-2027',
        stage: 'prod',
        pin: 'generate',
        openFrom: '2027-03-01T18:00:00-08:00',
        headline: 'Say cheese',
        accentColor: '#1a5fb4',
      },
    ]);
  });
});
