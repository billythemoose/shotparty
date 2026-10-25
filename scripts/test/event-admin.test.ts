import { describe, expect, it } from 'vitest';
import { err, ok } from '../../api/src/lib/result.js';
import { buildDisplayUpdate, parseClearList, parseLimitFlags } from '../lib/event-admin.js';

describe('buildDisplayUpdate', () => {
  it('sets the name and display fields under their stored attribute names', () => {
    expect(
      buildDisplayUpdate({
        name: 'Launch Night',
        set: { headline: 'Say cheese', accentColor: '#1a5fb4' },
        clear: [],
      }),
    ).toEqual(
      ok({
        UpdateExpression: 'SET #name = :name, #headline = :headline, #accentColor = :accentColor',
        ExpressionAttributeNames: {
          '#name': 'name',
          '#headline': 'display_headline',
          '#accentColor': 'display_accentColor',
        },
        ExpressionAttributeValues: {
          ':name': { S: 'Launch Night' },
          ':headline': { S: 'Say cheese' },
          ':accentColor': { S: '#1a5fb4' },
        },
      }),
    );
  });

  it('removes cleared fields, with no values when nothing is set', () => {
    expect(buildDisplayUpdate({ set: {}, clear: ['thanks', 'welcome'] })).toEqual(
      ok({
        UpdateExpression: 'REMOVE #welcome, #thanks',
        ExpressionAttributeNames: { '#welcome': 'display_welcome', '#thanks': 'display_thanks' },
      }),
    );
  });

  it('combines SET and REMOVE', () => {
    const update = buildDisplayUpdate({ set: { welcome: 'Hi' }, clear: ['accentColor'] });
    expect(update.ok && update.value?.UpdateExpression).toBe(
      'SET #welcome = :welcome REMOVE #accentColor',
    );
  });

  it('returns null when there is nothing to change', () => {
    expect(buildDisplayUpdate({ set: {}, clear: [] })).toEqual(ok(null));
  });

  it('refuses to set and clear the same field', () => {
    expect(buildDisplayUpdate({ set: { thanks: 'x' }, clear: ['thanks'] })).toEqual(
      err({ kind: 'set-and-clear', field: 'thanks' }),
    );
  });
});

describe('buildDisplayUpdate with quotas', () => {
  it('sets quota overrides as numbers under their stored attribute names', () => {
    expect(
      buildDisplayUpdate({
        set: {},
        clear: [],
        limits: { sessionFiles: 2000, sessionBytes: 50 * 1024 ** 3 },
      }),
    ).toEqual(
      ok({
        UpdateExpression: 'SET #sessionFiles = :sessionFiles, #sessionBytes = :sessionBytes',
        ExpressionAttributeNames: {
          '#sessionFiles': 'limit_sessionFiles',
          '#sessionBytes': 'limit_sessionBytes',
        },
        ExpressionAttributeValues: {
          ':sessionFiles': { N: '2000' },
          ':sessionBytes': { N: '53687091200' },
        },
      }),
    );
  });

  it('combines quotas with display changes', () => {
    const update = buildDisplayUpdate({
      set: { thanks: 'Ta' },
      clear: ['headline'],
      limits: { eventFiles: 9 },
    });
    expect(update.ok && update.value?.UpdateExpression).toBe(
      'SET #thanks = :thanks, #eventFiles = :eventFiles REMOVE #headline',
    );
  });
});

describe('parseLimitFlags', () => {
  it('turns counts and GiB into quota overrides, ignoring flags not given', () => {
    expect(parseLimitFlags({ 'session-files': '2000', 'session-gb': '2.5' })).toEqual(
      ok({ sessionFiles: 2000, sessionBytes: 2.5 * 1024 ** 3 }),
    );
    expect(
      parseLimitFlags({ 'ip-files-per-hour': '10', 'event-files': '3', 'event-gb': '1' }),
    ).toEqual(ok({ ipFilesPerHour: 10, eventFiles: 3, eventBytes: 1024 ** 3 }));
    expect(parseLimitFlags({})).toEqual(ok({}));
  });

  it.each(['0', '-1', 'lots', '', '0.2'])('rejects --session-files %j', (value) => {
    expect(parseLimitFlags({ 'session-files': value })).toEqual(
      err({ kind: 'invalid-limit', flag: 'session-files' }),
    );
  });
});

describe('parseClearList', () => {
  it('parses a comma list, "all" and nothing', () => {
    expect(parseClearList(' thanks , accentColor ')).toEqual(ok(['thanks', 'accentColor']));
    expect(parseClearList('all')).toEqual(ok(['headline', 'welcome', 'thanks', 'accentColor']));
    expect(parseClearList(undefined)).toEqual(ok([]));
  });

  it('rejects unknown fields', () => {
    expect(parseClearList('headline,color')).toEqual(
      err({ kind: 'unknown-field', field: 'color' }),
    );
  });
});
