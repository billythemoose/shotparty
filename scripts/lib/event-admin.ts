/**
 * @fileoverview Shared by the organizer commands that change an existing event (event:close,
 * event:update).
 */
import { type AttributeValue, type DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import {
  DISPLAY_FIELDS,
  displayAttr,
  type EventDisplay,
  eventFromItem,
  type EventRecord,
  limitAttr,
} from '../../api/src/lib/events.js';
import type { QuotaLimits } from '../../api/src/lib/quota.js';
import { err, ok, type Result } from '../../api/src/lib/result.js';

/** A display field's name, as on the command line. */
export type DisplayField = (typeof DISPLAY_FIELDS)[number];

/** Finds an event by its folder name (events are few, so a filtered scan is fine). */
export async function findEventByFolder(
  ddb: DynamoDBClient,
  tableName: string,
  eventId: string,
): Promise<EventRecord[]> {
  const found: EventRecord[] = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :e) AND eventId = :id',
        ExpressionAttributeValues: { ':e': { S: 'EVENT#' }, ':id': { S: eventId } },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items ?? []) {
      // The filter matched begins_with(pk, "EVENT#"), so pk is set.
      const pk = item.pk?.S ?? '';
      found.push(eventFromItem(pk.slice('EVENT#'.length), item));
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return found;
}

/** A quota override flag, as on the command line. */
export type LimitFlag =
  'session-files' | 'session-gb' | 'ip-files-per-hour' | 'event-files' | 'event-gb';

// Counts are whole numbers; sizes are given in GiB.
const LIMIT_FLAGS: Record<LimitFlag, { key: keyof QuotaLimits; unit: number }> = {
  'session-files': { key: 'sessionFiles', unit: 1 },
  'session-gb': { key: 'sessionBytes', unit: 1024 ** 3 },
  'ip-files-per-hour': { key: 'ipFilesPerHour', unit: 1 },
  'event-files': { key: 'eventFiles', unit: 1 },
  'event-gb': { key: 'eventBytes', unit: 1024 ** 3 },
};

/** Every quota override flag, in display order. */
// Object.keys of a Record<LimitFlag, ...> literal is exactly LimitFlag[].
export const LIMIT_FLAG_NAMES = Object.keys(LIMIT_FLAGS) as LimitFlag[];

/** A quota flag whose value isn't a positive number. */
export interface InvalidLimit {
  kind: 'invalid-limit';
  flag: LimitFlag;
}

/** Turns --session-files, --session-gb, ... into quota overrides (sizes in bytes). */
export function parseLimitFlags(
  raw: Partial<Record<LimitFlag, string>>,
): Result<Partial<QuotaLimits>, InvalidLimit> {
  const limits: Partial<QuotaLimits> = {};
  for (const flag of LIMIT_FLAG_NAMES) {
    const value = raw[flag];
    if (value === undefined) continue;
    const { key, unit } = LIMIT_FLAGS[flag];
    const scaled = Math.round(Number(value) * unit);
    if (!Number.isSafeInteger(scaled) || scaled < 1) return err({ kind: 'invalid-limit', flag });
    limits[key] = scaled;
  }
  return ok(limits);
}

/** What event:update was asked to change. */
export interface DisplayChanges {
  name?: string;
  /** Fields to set (already normalized). */
  set: EventDisplay;
  /** Fields to remove, so the page falls back to its default. */
  clear: DisplayField[];
  /** Quota overrides to set (from {@link parseLimitFlags}). */
  limits?: Partial<QuotaLimits>;
}

/** The UpdateItem fields that apply a {@link DisplayChanges}. */
export interface DisplayUpdate {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, { S: string } | { N: string }>;
}

/** The same field was both set and cleared. */
export interface SetAndClear {
  kind: 'set-and-clear';
  field: DisplayField;
}

/** --clear named a field that doesn't exist. */
export interface UnknownField {
  kind: 'unknown-field';
  field: string;
}

/** Returns the update for a set of changes, null when there is nothing to change. */
export function buildDisplayUpdate(
  changes: DisplayChanges,
): Result<DisplayUpdate | null, SetAndClear> {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, { S: string } | { N: string }> = {};

  if (changes.name) {
    names['#name'] = 'name';
    values[':name'] = { S: changes.name };
    sets.push('#name = :name');
  }
  for (const field of DISPLAY_FIELDS) {
    const value = changes.set[field];
    if (value && changes.clear.includes(field)) return err({ kind: 'set-and-clear', field });
    if (value) {
      names[`#${field}`] = displayAttr(field);
      values[`:${field}`] = { S: value };
      sets.push(`#${field} = :${field}`);
    } else if (changes.clear.includes(field)) {
      names[`#${field}`] = displayAttr(field);
      removes.push(`#${field}`);
    }
  }
  for (const { key } of Object.values(LIMIT_FLAGS)) {
    const value = changes.limits?.[key];
    if (value === undefined) continue;
    names[`#${key}`] = limitAttr(key);
    values[`:${key}`] = { N: String(value) };
    sets.push(`#${key} = :${key}`);
  }
  if (!sets.length && !removes.length) return ok(null);

  const expression = [
    ...(sets.length ? [`SET ${sets.join(', ')}`] : []),
    ...(removes.length ? [`REMOVE ${removes.join(', ')}`] : []),
  ].join(' ');
  return ok({
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  });
}

function isDisplayField(name: string): name is DisplayField {
  return DISPLAY_FIELDS.some((field) => field === name);
}

/** Parses --clear "headline,thanks" (or "all"). */
export function parseClearList(raw: string | undefined): Result<DisplayField[], UnknownField> {
  if (!raw) return ok([]);
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.includes('all')) return ok([...DISPLAY_FIELDS]);
  const fields: DisplayField[] = [];
  for (const p of parts) {
    if (!isDisplayField(p)) return err({ kind: 'unknown-field', field: p });
    fields.push(p);
  }
  return ok(fields);
}
