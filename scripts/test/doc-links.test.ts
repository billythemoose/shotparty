import { describe, expect, it } from 'vitest';
import {
  anchorsOf,
  checkLink,
  type DocLink,
  findLinks,
  headingSlug,
  isRepoLink,
} from '../lib/doc-links.js';

const FILES: Record<string, string> = {
  'api/src/lib/quota.ts': 'line one\nexport function reserveQuota() {}\nline three\n',
  'docs/how-it-works/quotas.md': '# Quotas\n\n## Why not a transaction\n\n## Notes\n\n## Notes\n',
  'docs/page.md': 'text <a id="the-origin-check"></a> more\n',
};

function read(path: string): string | null {
  return FILES[path] ?? null;
}

function link(target: string, text = 'x'): DocLink {
  return { line: 1, text, target };
}

describe('findLinks', () => {
  it('finds Markdown links, images and HTML sources with their line numbers', () => {
    const md = [
      'See [quotas](quotas.md) and ![diagram](a.svg).',
      '<source srcset="b-dark.svg" /> <img src="b-light.svg" />',
      'A code name: [`reserveQuota`](../quota.ts#L2).',
    ].join('\n');
    expect(findLinks(md)).toEqual([
      { line: 1, text: 'quotas', target: 'quotas.md' },
      { line: 1, text: 'diagram', target: 'a.svg' },
      { line: 2, text: '', target: 'b-dark.svg' },
      { line: 2, text: '', target: 'b-light.svg' },
      { line: 3, text: '`reserveQuota`', target: '../quota.ts#L2' },
    ]);
  });

  it('ignores links inside fenced code and inline code', () => {
    const md = ['```md', '[in a fence](nope.md)', '```', 'Write `[text](nope.md)` like this.'];
    expect(findLinks(md.join('\n'))).toEqual([]);
  });
});

describe('isRepoLink', () => {
  it('skips URLs and mail links', () => {
    expect(isRepoLink('https://docs.aws.amazon.com/')).toBe(false);
    expect(isRepoLink('mailto:someone@example.com')).toBe(false);
    expect(isRepoLink('../how-it-works/README.md')).toBe(true);
    expect(isRepoLink('#duplicates')).toBe(true);
  });
});

describe('headingSlug and anchorsOf', () => {
  it('follows GitHub: lowercase, punctuation dropped, spaces as dashes', () => {
    expect(headingSlug('Sessions and the gate')).toBe('sessions-and-the-gate');
    expect(headingSlug('Abuse protection (defense in depth)')).toBe(
      'abuse-protection-defense-in-depth',
    );
    expect(headingSlug('The `ttl` attribute')).toBe('the-ttl-attribute');
    expect(headingSlug('Presign and the S3 POST policy')).toBe('presign-and-the-s3-post-policy');
  });

  it('numbers repeated headings and includes explicit anchors', () => {
    const anchors = anchorsOf(
      '## Notes\n## Notes\n<a id="custom"></a>\n```\n# not a heading\n```\n',
    );
    expect([...anchors].sort()).toEqual(['custom', 'notes', 'notes-1']);
  });
});

describe('checkLink', () => {
  const from = 'docs/how-it-works/quotas.md';

  it('accepts a file, a line, a code name on that line and a heading anchor', () => {
    expect(checkLink(link('../../api/src/lib/quota.ts'), from, read).ok).toBe(true);
    expect(checkLink(link('../../api/src/lib/quota.ts#L3'), from, read).ok).toBe(true);
    const named = link('../../api/src/lib/quota.ts#L2', '`reserveQuota`');
    expect(checkLink(named, from, read).ok).toBe(true);
    expect(checkLink(link('#why-not-a-transaction'), from, read).ok).toBe(true);
    expect(checkLink(link('#notes-1'), from, read).ok).toBe(true);
    expect(checkLink(link('../page.md#the-origin-check'), from, read).ok).toBe(true);
  });

  it('reports a missing file', () => {
    expect(checkLink(link('../nope.md'), from, read)).toEqual({
      ok: false,
      error: { kind: 'missing-file', path: 'docs/nope.md' },
    });
  });

  it('reports a line past the end of the file', () => {
    expect(checkLink(link('../../api/src/lib/quota.ts#L4'), from, read)).toEqual({
      ok: false,
      error: { kind: 'line-out-of-range', path: 'api/src/lib/quota.ts', line: 4, lineCount: 3 },
    });
  });

  it('reports a code name that moved off its line', () => {
    const moved = link('../../api/src/lib/quota.ts#L3', '`reserveQuota`');
    expect(checkLink(moved, from, read)).toEqual({
      ok: false,
      error: {
        kind: 'name-not-on-line',
        path: 'api/src/lib/quota.ts',
        line: 3,
        name: 'reserveQuota',
      },
    });
  });

  it('reports a heading anchor that matches nothing', () => {
    expect(checkLink(link('#why-a-transaction'), from, read)).toEqual({
      ok: false,
      error: { kind: 'missing-anchor', path: from, anchor: 'why-a-transaction' },
    });
  });
});
