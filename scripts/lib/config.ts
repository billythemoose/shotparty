/**
 * @fileoverview Loads and validates shotparty.config.json, the one file that holds every value a
 * self-hoster provides (see shotparty.config.schema.json). Secrets never live here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ErrorObject } from 'ajv';
import addFormatsPlugin from 'ajv-formats';
import schema from '../../shotparty.config.schema.json' with { type: 'json' };
import { DEFAULT_LIMITS } from '../../api/src/lib/quota.js';
import { assertIsError } from '../../api/src/lib/result.js';
import { MAX_UPLOAD_BYTES } from '../../api/src/lib/upload-policy.js';

/** The stages a config can define. */
export const STAGES = ['dev', 'prod'] as const;
/** One of {@link STAGES}. */
export type StageName = (typeof STAGES)[number];

/** One stage's settings, with defaults filled in. */
export interface StageConfig {
  /** Absent until setup creates the widget (only allowed with the cloudflare section). */
  turnstileSiteKey?: string;
  archiveAfterDays: number;
  localDev: boolean;
}

/** An event setup creates (events[] in the config). */
export interface EventConfig {
  name: string;
  eventId: string;
  /** Which stage `npm run setup` creates it in (default prod, or dev when there is no prod). */
  stage: StageName;
  openFrom?: string;
  openUntil?: string;
  pin: 'none' | 'generate';
  headline?: string;
  welcome?: string;
  thanks?: string;
  accentColor?: string;
}

/** Upload limits for every stage (uploads in the config), converted to bytes. */
export interface UploadsConfig {
  maxFileBytes: number;
  sessionFiles: number;
  sessionBytes: number;
}

/** A validated config with defaults filled in. */
export interface Config {
  aws: { profile: string; region: string; prefix: string };
  alerts: { email?: string };
  /** The account-wide monthly budget in USD (0 = none), in the <prefix>-account stack. */
  budgets: { accountMonthlyUsd: number };
  cloudflare?: { accountId: string };
  stages: Partial<Record<StageName, StageConfig>>;
  uploads: UploadsConfig;
  events: EventConfig[];
  download: { outDir: string };
}

const GIB = 1024 ** 3;

/** The account budget when the config doesn't set budgets.accountMonthlyUsd. */
export const DEFAULT_ACCOUNT_BUDGET_USD = 20;

/** The repository's root directory. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Where the config lives unless SHOTPARTY_CONFIG says otherwise. */
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'shotparty.config.json');

/** A missing or invalid config; `problems` lists every rule it breaks. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

// ajv-formats is CommonJS; its default export arrives wrapped under some loaders.
const addFormats = ((addFormatsPlugin as unknown as { default?: typeof addFormatsPlugin })
  .default ?? addFormatsPlugin) as typeof addFormatsPlugin;
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function describe(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : '(top level)';
  if (e.keyword === 'additionalProperties') {
    const setting = String(e.params.additionalProperty);
    if (setting === 'accountBudget') {
      return (
        `${where}: "accountBudget" was replaced by budgets.accountMonthlyUsd (default 20): ` +
        'the account budget now has its own stack, so it no longer depends on one stage. ' +
        'Remove accountBudget.'
      );
    }
    return `${where}: unknown setting "${setting}"`;
  }
  if (e.keyword === 'required') return `${where}: missing "${String(e.params.missingProperty)}"`;
  return `${where}: ${e.message ?? 'is invalid'}`;
}

/**
 * Cross-field rules JSON Schema can't express. Written defensively so they also run on a config
 * that failed the schema: the first run then lists every problem, not just the schema ones.
 */
function crossFieldProblems(raw: unknown): string[] {
  const problems: string[] = [];
  const obj = (v: unknown): Record<string, unknown> =>
    // A non-array object, checked first.
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const stages = obj(obj(raw).stages);
  const managed = typeof obj(obj(raw).cloudflare).accountId === 'string';
  for (const n of STAGES) {
    if (stages[n] !== undefined && obj(stages[n]).turnstileSiteKey === undefined && !managed) {
      problems.push(
        `stages.${n}: missing "turnstileSiteKey" (or set cloudflare.accountId so setup creates the widget)`,
      );
    }
  }
  const uploads = obj(obj(raw).uploads);
  const maxFileGb = typeof uploads.maxFileGb === 'number' ? uploads.maxFileGb : 1;
  if (typeof uploads.sessionGb === 'number' && uploads.sessionGb < maxFileGb) {
    problems.push(
      `uploads.sessionGb (${uploads.sessionGb}) is below maxFileGb (${maxFileGb}), so the largest files could never be uploaded`,
    );
  }
  const events = obj(raw).events;
  const seen = new Set<string>();
  (Array.isArray(events) ? events : []).forEach((ev, i) => {
    const e = obj(ev);
    if (typeof e.eventId === 'string') {
      if (seen.has(e.eventId)) problems.push(`events.${i}.eventId: "${e.eventId}" is used twice`);
      seen.add(e.eventId);
    }
    const from = typeof e.openFrom === 'string' ? Date.parse(e.openFrom) : NaN;
    const until = typeof e.openUntil === 'string' ? Date.parse(e.openUntil) : NaN;
    if (until <= from) problems.push(`events.${i}: openUntil must be after openFrom`);
    if (typeof e.stage === 'string' && isStage(e.stage) && !obj(stages)[e.stage]) {
      problems.push(`events.${i}.stage: "${e.stage}" is not defined in stages`);
    }
  });
  return problems;
}

/** Validates a parsed config and fills in defaults. Throws ConfigError listing every problem. */
export function parseConfig(raw: unknown): Config {
  const schemaOk = validate(raw);
  const problems = [...(schemaOk ? [] : (validate.errors ?? []).map(describe))];
  problems.push(...crossFieldProblems(raw));
  if (problems.length) throw new ConfigError('invalid shotparty config', problems);

  // raw passed the schema, which describes this shape.
  const input = raw as {
    aws?: Partial<Config['aws']>;
    alerts?: Config['alerts'];
    budgets?: Partial<Config['budgets']>;
    cloudflare?: Config['cloudflare'];
    stages: Partial<Record<StageName, Partial<StageConfig>>>;
    uploads?: { maxFileGb?: number; sessionFiles?: number; sessionGb?: number };
    events?: Array<
      Omit<EventConfig, 'pin' | 'stage'> & Partial<Pick<EventConfig, 'pin' | 'stage'>>
    >;
    download?: Partial<Config['download']>;
  };

  const stages: Config['stages'] = {};
  for (const name of STAGES) {
    const s = input.stages[name];
    if (!s) continue;
    stages[name] = {
      ...(s.turnstileSiteKey ? { turnstileSiteKey: s.turnstileSiteKey } : {}),
      archiveAfterDays: s.archiveAfterDays ?? 0,
      localDev: s.localDev ?? name === 'dev',
    };
  }
  const defaultStage: StageName = stages.prod ? 'prod' : 'dev';
  const events = (input.events ?? []).map((e) => ({
    ...e,
    pin: e.pin ?? 'none',
    stage: e.stage ?? defaultStage,
  }));

  return {
    aws: {
      profile: input.aws?.profile ?? 'shotparty',
      region: input.aws?.region ?? 'us-east-1',
      prefix: input.aws?.prefix ?? 'shotparty',
    },
    alerts: { ...input.alerts },
    budgets: {
      accountMonthlyUsd: input.budgets?.accountMonthlyUsd ?? DEFAULT_ACCOUNT_BUDGET_USD,
    },
    ...(input.cloudflare ? { cloudflare: { accountId: input.cloudflare.accountId } } : {}),
    stages,
    uploads: {
      maxFileBytes: gibToBytes(input.uploads?.maxFileGb) ?? MAX_UPLOAD_BYTES,
      sessionFiles: input.uploads?.sessionFiles ?? DEFAULT_LIMITS.sessionFiles,
      sessionBytes: gibToBytes(input.uploads?.sessionGb) ?? DEFAULT_LIMITS.sessionBytes,
    },
    events,
    download: { outDir: input.download?.outDir ?? 'photos' },
  };
}

function gibToBytes(gib: number | undefined): number | undefined {
  return gib === undefined ? undefined : Math.round(gib * GIB);
}

/** Reads the config from SHOTPARTY_CONFIG, or shotparty.config.json at the repo root. */
export function configPath(): string {
  return process.env.SHOTPARTY_CONFIG ?? DEFAULT_CONFIG_PATH;
}

/** Loads and validates the config file (default: configPath()). */
export function loadConfig(path = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      `no config at ${path}. Copy shotparty.config.example.json to shotparty.config.json and edit it.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    assertIsError(e);
    throw new ConfigError(`${path} is not valid JSON: ${e.message}`);
  }
  return parseConfig(raw);
}

/** For CLI scripts: load the config or print the problems and exit. */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (e: unknown) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

/** The settings for one stage; throws if the config doesn't define it. */
export function stageConfig(config: Config, stage: StageName): StageConfig {
  const s = config.stages[stage];
  if (!s) throw new ConfigError(`stage "${stage}" is not defined in the config (stages.${stage})`);
  return s;
}

/** The profile to use: --profile, then SHOTPARTY_PROFILE, then the config. */
export function awsProfile(config: Config, override?: string): string {
  return override ?? process.env.SHOTPARTY_PROFILE ?? config.aws.profile;
}

/** The stack that holds the account-wide budget (one per prefix, not per stage). */
export function accountStackName(config: Config): string {
  return `${config.aws.prefix}-account`;
}

/** The AWS resource names for one stage. */
export interface StageNames {
  dataStack: string;
  appStack: string;
  /** Returns the SSM parameter name for one of the stage's settings or secrets. */
  param: (name: string) => string;
  alertEmailParam: string;
}

/** Returns every AWS name derived from the prefix and stage, in one place. */
export function names(config: Config, stage: StageName): StageNames {
  const prefix = config.aws.prefix;
  return {
    dataStack: `${prefix}-${stage}-data`,
    appStack: `${prefix}-${stage}-app`,
    param: (name) => `/${prefix}/${stage}/${name}`,
    alertEmailParam: `/${prefix}/alert_email`,
  };
}

/** The config's event with this eventId; throws if there isn't one. */
export function configEvent(config: Config, eventId: string): EventConfig {
  const e = config.events.find((x) => x.eventId === eventId);
  if (!e) {
    const known = config.events.map((x) => x.eventId).join(', ') || 'none';
    throw new ConfigError(`no event "${eventId}" in the config's events (defined: ${known})`);
  }
  return e;
}

/** Narrows a command-line value to a stage name. */
export function isStage(value: unknown): value is StageName {
  return STAGES.some((stage) => stage === value);
}
