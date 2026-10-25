/**
 * @fileoverview Manages the Cloudflare Turnstile widget through the Cloudflare API, so setup never
 * needs the Cloudflare dashboard. https://developers.cloudflare.com/api/resources/turnstile/
 *
 * One widget per install, named after the config's prefix and shared by its stages (each stage
 * adds its own *.cloudfront.net hostname), as docs/ARCHITECTURE.md describes.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's test site key that always fails: deploys use it until the real widget exists. */
export const ALWAYS_BLOCK_SITE_KEY = '2x00000000000000000000AB';

/** A Turnstile widget as the Cloudflare API returns it (snake_case, as on the wire). */
export interface Widget {
  sitekey: string;
  secret?: string;
  name: string;
  domains: string[];
  mode: string;
  bot_fight_mode?: boolean;
  clearance_level?: string;
  ephemeral_id?: boolean;
  offlabel?: boolean;
  region?: string;
}

interface CloudflareApiError {
  code: number;
  message: string;
}

/** Cloudflare's response wrapper. */
interface Envelope<T> {
  success: boolean;
  errors?: CloudflareApiError[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiError(value: unknown): value is CloudflareApiError {
  return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string';
}

/** Narrows a parsed response to an envelope; `result` is checked only when the call succeeded. */
function isEnvelope<T>(value: unknown, isResult: (v: unknown) => v is T): value is Envelope<T> {
  if (!isRecord(value) || typeof value.success !== 'boolean') return false;
  const { errors, result_info: info } = value;
  if (errors !== undefined && !(Array.isArray(errors) && errors.every(isApiError))) return false;
  if (
    info !== undefined &&
    !(isRecord(info) && typeof info.page === 'number' && typeof info.total_pages === 'number')
  ) {
    return false;
  }
  return !value.success || isResult(value.result);
}

/** Narrows an API value to a {@link Widget}. */
function isWidget(value: unknown): value is Widget {
  return (
    isRecord(value) &&
    typeof value.sitekey === 'string' &&
    typeof value.name === 'string' &&
    typeof value.mode === 'string' &&
    Array.isArray(value.domains) &&
    value.domains.every((d) => typeof d === 'string') &&
    (value.secret === undefined || typeof value.secret === 'string')
  );
}

function isWidgetList(value: unknown): value is Widget[] {
  return Array.isArray(value) && value.every(isWidget);
}

/** A failed Cloudflare API call; `status` is its HTTP status. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

/** The Turnstile widget endpoints of the Cloudflare API, for one account. */
export class TurnstileApi {
  /**
   * @param accountId The Cloudflare account that owns the widget.
   * @param token An API token with Account > Turnstile > Edit.
   * @param fetchImpl Replaced in tests.
   */
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    isResult: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<Envelope<T>> {
    const res = await this.fetchImpl(
      `${API}/accounts/${this.accountId}/challenges/widgets${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const env: unknown = await res.json().catch(() => undefined);
    if (!isEnvelope(env, isResult)) {
      throw new CloudflareError(
        `Cloudflare API ${method} ${path || '/'}: HTTP ${res.status}`,
        res.status,
      );
    }
    if (!res.ok || !env.success) {
      const why =
        env.errors?.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${res.status}`;
      const hint =
        res.status === 401 || res.status === 403
          ? '. Check that CLOUDFLARE_API_TOKEN has Account > Turnstile > Edit for this account'
          : '';
      throw new CloudflareError(
        `Cloudflare API ${method} ${path || '/'}: ${why}${hint}`,
        res.status,
      );
    }
    return env;
  }

  /** Returns every widget in the account. */
  async list(): Promise<Widget[]> {
    const all: Widget[] = [];
    for (let page = 1; ; page++) {
      const env = await this.call('GET', `?page=${page}&per_page=50`, isWidgetList);
      all.push(...env.result);
      if (!env.result_info || page >= env.result_info.total_pages) return all;
    }
  }

  /** The widget with this site key (including its secret), or null if the account has none. */
  async get(sitekey: string): Promise<Widget | null> {
    try {
      return (await this.call('GET', `/${encodeURIComponent(sitekey)}`, isWidget)).result;
    } catch (e: unknown) {
      if (e instanceof CloudflareError && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  /** Creates a managed-mode widget for these hostnames. */
  async create(name: string, domains: string[]): Promise<Widget> {
    return (await this.call('POST', '', isWidget, { name, domains, mode: 'managed' })).result;
  }

  /**
   * PUT replaces the widget, so its settings are sent back unchanged. The enterprise-only flags
   * only when they're on (a free account may refuse them), and never region (fixed at creation).
   */
  async update(widget: Widget, domains: string[]): Promise<Widget> {
    const body: Record<string, unknown> = { name: widget.name, mode: widget.mode, domains };
    if (widget.clearance_level) body.clearance_level = widget.clearance_level;
    for (const k of ['bot_fight_mode', 'ephemeral_id', 'offlabel'] as const) {
      if (widget[k]) body[k] = true;
    }
    const path = `/${encodeURIComponent(widget.sitekey)}`;
    return (await this.call('PUT', path, isWidget, body)).result;
  }
}

/** The widget setup ended up with, and what it changed. */
export interface EnsureResult {
  widget: Widget & { secret: string };
  /** What changed in Cloudflare, for the log ("created", "added host", or nothing). */
  actions: string[];
}

/**
 * Makes sure a widget exists and allows `host`: the one with `siteKey` when the config has one,
 * else the one named `name` (a re-run after a crash finds it), else a new one.
 */
export async function ensureWidget(
  api: TurnstileApi,
  opts: { siteKey?: string; name: string; host: string },
): Promise<EnsureResult> {
  const actions: string[] = [];
  let widget: Widget | null;
  if (opts.siteKey) {
    widget = await api.get(opts.siteKey);
    if (!widget) {
      throw new CloudflareError(
        `the Cloudflare account has no Turnstile widget with site key ${opts.siteKey}. ` +
          'Fix turnstileSiteKey, or remove it so setup creates the widget',
        404,
      );
    }
  } else {
    const existing = (await api.list()).find((x) => x.name === opts.name);
    if (existing) {
      widget = await api.get(existing.sitekey);
      actions.push(`reusing widget "${opts.name}"`);
    } else {
      widget = await api.create(opts.name, [opts.host]);
      actions.push(`created widget "${opts.name}"`);
    }
  }
  if (!widget) {
    throw new CloudflareError(`widget "${opts.name}" disappeared while setting it up`, 404);
  }
  if (!widget.domains.includes(opts.host)) {
    widget = {
      ...widget,
      ...(await api.update(widget, [...widget.domains, opts.host])),
      secret: widget.secret,
    };
    actions.push(`added ${opts.host} to its hostnames`);
  }
  if (!widget.secret) {
    // Create and update responses may leave the secret out; the details call always has it.
    widget = { ...widget, secret: (await api.get(widget.sitekey))?.secret };
  }
  const { secret } = widget;
  if (!secret) {
    throw new CloudflareError(`Cloudflare returned no secret for widget ${widget.sitekey}`, 500);
  }
  return { widget: { ...widget, secret }, actions };
}

/** The config file's text with `stages.<stage>.turnstileSiteKey` set, other settings untouched. */
export function withSiteKey(configText: string, stage: string, siteKey: string): string {
  const raw: unknown = JSON.parse(configText);
  const stageSettings = isRecord(raw) && isRecord(raw.stages) ? raw.stages[stage] : undefined;
  if (!isRecord(stageSettings)) throw new Error(`the config has no stages.${stage}`);
  stageSettings.turnstileSiteKey = siteKey;
  return `${JSON.stringify(raw, null, 2)}\n`;
}
