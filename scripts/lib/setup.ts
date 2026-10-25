/** @fileoverview Pure helpers for scripts/setup.ts (kept separate so they can be unit-tested). */
import { eventIdFromName, yearOf } from '../../api/src/lib/events.js';
import type { StageName } from './config.js';

/** Cloudflare's documented Turnstile test site keys (always pass / always block / force challenge). */
export function isTestSiteKey(key: string): boolean {
  return /^[123]x0{20}[A-Z]{2}$/.test(key);
}

/** Cloudflare's always-pass test site key. */
export const TEST_SITE_KEY = '1x00000000000000000000AA';
/** The always-pass test secret that goes with the test site keys. */
export const TEST_SECRET = '1x0000000000000000000000000000000AA';

/** "v22.19.0" or "22" -> 22. */
export function majorVersion(v: string): number {
  const m = /^v?(\d+)/.exec(v.trim());
  return m ? Number(m[1]) : NaN;
}

/** A command-line tool setup needs. */
export interface Tool {
  name: string;
  /** Command that prints a version (exit 0 means installed). */
  check: [string, ...string[]];
  install: string;
}

/** Everything setup checks for before it starts (Node is checked separately). */
export const TOOLS: Tool[] = [
  {
    name: 'AWS CLI v2',
    check: ['aws', '--version'],
    install:
      'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html (macOS: brew install awscli)',
  },
  {
    name: 'AWS SAM CLI',
    check: ['sam', '--version'],
    install:
      'https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html (macOS: brew install aws-sam-cli)',
  },
  {
    name: 'cfn-lint',
    check: ['cfn-lint', '--version'],
    install: 'pip install cfn-lint (or brew install cfn-lint)',
  },
  {
    name: 'python3',
    check: ['python3', '--version'],
    install: 'https://www.python.org/downloads/',
  },
  { name: 'openssl', check: ['openssl', 'version'], install: 'preinstalled on macOS/Linux' },
];

/** Pulls what event:create printed that the summary needs. */
export function parseCreateOutput(output: string): { guestUrl?: string; pin?: string } {
  const guestUrl = /Guest URL:\s+(\S+)/.exec(output)?.[1];
  const pin = /PIN:\s+(\d+)/.exec(output)?.[1];
  return { ...(guestUrl ? { guestUrl } : {}), ...(pin ? { pin } : {}) };
}

/** What the setup interview collects. */
export interface WizardAnswers {
  profile: string;
  region: string;
  prefix: string;
  email: string;
  stages: StageName[];
  /** Cloudflare account ID: setup then creates the widget for any stage left without a key. */
  cloudflareAccountId?: string;
  siteKeys: Partial<Record<StageName, string>>;
  event?: {
    name: string;
    eventId?: string;
    openFrom?: string;
    openUntil?: string;
    pin: boolean;
    headline?: string;
    welcome?: string;
    thanks?: string;
    accentColor?: string;
  };
}

/** The config file the wizard writes (validated with parseConfig before it is saved). */
export function configFromAnswers(answers: WizardAnswers): Record<string, unknown> {
  const stages: Record<string, unknown> = {};
  // Budgets are per account: put it on the first stage (dev when there is one).
  answers.stages.forEach((s, i) => {
    const key = answers.siteKeys[s] || (answers.cloudflareAccountId ? undefined : TEST_SITE_KEY);
    stages[s] = {
      ...(key ? { turnstileSiteKey: key } : {}),
      ...(i === 0 ? { accountBudget: true } : {}),
    };
  });
  const config: Record<string, unknown> = {
    $schema: './shotparty.config.schema.json',
    aws: { profile: answers.profile, region: answers.region, prefix: answers.prefix },
    alerts: { email: answers.email },
    ...(answers.cloudflareAccountId
      ? { cloudflare: { accountId: answers.cloudflareAccountId } }
      : {}),
    stages,
  };
  if (answers.event) {
    const event = answers.event;
    const optional = Object.fromEntries(
      (
        [
          ['openFrom', event.openFrom],
          ['openUntil', event.openUntil],
          ['headline', event.headline],
          ['welcome', event.welcome],
          ['thanks', event.thanks],
          ['accentColor', event.accentColor],
        ] as const
      ).filter(([, v]) => v),
    );
    config.events = [
      {
        name: event.name,
        eventId: event.eventId || eventIdFromName(event.name, yearOf(event.openFrom)),
        stage: answers.stages.includes('prod') ? 'prod' : 'dev',
        pin: event.pin ? 'generate' : 'none',
        ...optional,
      },
    ];
  }
  return config;
}
