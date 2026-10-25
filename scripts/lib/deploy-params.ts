/**
 * @fileoverview Turns the config plus a few values discovered in AWS into `sam deploy` arguments,
 * replacing the hand-edited samconfig.toml files.
 */
import { type Config, names, type StageName, stageConfig } from './config.js';
import { isTestSiteKey } from './setup.js';
import { ALWAYS_BLOCK_SITE_KEY } from './turnstile-widget.js';

/** The Vite dev server, allowed as an upload origin on stages with localDev. */
const LOCAL_ORIGIN = 'http://localhost:5173';

/** Facts read from the live account (both absent before the app stack's first deploy). */
export interface Discovered {
  /** App stack output SiteUrl, e.g. https://d123.cloudfront.net */
  siteUrl?: string;
  /** Web ACL currently attached to the distribution (the CloudFront Free plan's), if any. */
  webAclArn?: string;
}

/** What `sam deploy` needs for one stack. */
export interface DeployParams {
  stackName: string;
  parameterOverrides: string[];
  tags: string[];
  /** Things the operator should know, e.g. that a second pass is needed. */
  warnings: string[];
}

/** Which of a stage's two stacks. */
export type StackKind = 'data' | 'app';

/** Returns the `sam deploy` arguments for one stack of one stage. */
export function deployParams(
  config: Config,
  stage: StageName,
  kind: StackKind,
  discovered: Discovered,
): DeployParams {
  const settings = stageConfig(config, stage);
  const awsNames = names(config, stage);
  const prefix = config.aws.prefix;
  const tags = [`project=${prefix}`, `stage=${stage}`];
  const warnings: string[] = [];
  const siteHost = discovered.siteUrl ? new URL(discovered.siteUrl).host : undefined;
  const secondPass =
    `no site URL yet (the app stack isn't deployed), so ${stage} only allows local origins. ` +
    `Re-run "scripts/deploy.sh data ${stage}" and "scripts/deploy.sh app ${stage}" once the app stack exists.`;

  if (kind === 'data') {
    const origins = [discovered.siteUrl, settings.localDev ? LOCAL_ORIGIN : undefined].filter(
      (o): o is string => Boolean(o),
    );
    if (!discovered.siteUrl) warnings.push(secondPass);
    // The bucket's CORS rule needs at least one origin; localhost is harmless (presign still gates uploads).
    if (origins.length === 0) origins.push(LOCAL_ORIGIN);
    return {
      stackName: awsNames.dataStack,
      parameterOverrides: [
        `Stage=${stage}`,
        `Prefix=${prefix}`,
        `AllowedOrigins=${origins.join(',')}`,
        `ArchiveAfterDays=${settings.archiveAfterDays}`,
      ],
      tags,
      warnings,
    };
  }

  // Test keys' tokens don't report a real hostname, so the check is off for them.
  const testKey =
    settings.turnstileSiteKey === undefined || isTestSiteKey(settings.turnstileSiteKey);
  const hostnames = testKey
    ? ''
    : [...(siteHost ? [siteHost] : []), ...(settings.localDev ? ['localhost'] : [])].join(',');
  if (!siteHost) warnings.push(secondPass);
  if (!settings.turnstileSiteKey) {
    warnings.push(
      `no Turnstile site key for ${stage} yet, so guests are refused until "npm run setup" creates the widget`,
    );
  }
  return {
    stackName: awsNames.appStack,
    parameterOverrides: [
      `Stage=${stage}`,
      `Prefix=${prefix}`,
      `MediaBucketName=${awsNames.param('mediaBucketName')}`,
      `TableName=${awsNames.param('tableName')}`,
      `TurnstileSiteKey=${settings.turnstileSiteKey ?? ALWAYS_BLOCK_SITE_KEY}`,
      `TurnstileHostnames=${samValue(hostnames)}`,
      `WebAclArn=${samValue(discovered.webAclArn ?? '')}`,
      `AccountBudget=${settings.accountBudget}`,
      `MaxUploadBytes=${config.uploads.maxFileBytes}`,
      `DefaultSessionFiles=${config.uploads.sessionFiles}`,
      `DefaultSessionBytes=${config.uploads.sessionBytes}`,
    ],
    tags,
    warnings,
  };
}

/** `sam deploy` rejects `Key=`; `Key=""` is its spelling of an empty value. */
function samValue(value: string): string {
  return value === '' ? '""' : value;
}

/** Quotes a value for safe use in `eval` by bash. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
