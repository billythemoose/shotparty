/**
 * @fileoverview Checks the relative links in the repo's Markdown: the target file exists, a `#L42`
 * line anchor is inside the file, a link whose text is a code name (`` [`reserveQuota`](…#L155) ``)
 * still lands on a line containing that name, and a `#heading` anchor matches a heading (GitHub's
 * slug rules) or an explicit `<a id>`. External URLs aren't fetched.
 */
import { posix } from 'node:path';
import { assertNever, err, ok, type Result } from '../../api/src/lib/result.js';

/** One link found in a Markdown file. */
export interface DocLink {
  /** 1-based line of the Markdown file the link is on. */
  line: number;
  /** The link text (empty for image sources). */
  text: string;
  target: string;
}

/** The linked file doesn't exist. */
export interface MissingFile {
  kind: 'missing-file';
  path: string;
}

/** A `#L<n>` anchor points past the end of the file. */
export interface LineOutOfRange {
  kind: 'line-out-of-range';
  path: string;
  line: number;
  lineCount: number;
}

/** The link names a symbol that the anchored line no longer contains (the code moved). */
export interface NameNotOnLine {
  kind: 'name-not-on-line';
  path: string;
  line: number;
  name: string;
}

/** A `#heading` anchor matches no heading or `<a id>` in the target. */
export interface MissingAnchor {
  kind: 'missing-anchor';
  path: string;
  anchor: string;
}

/** Why a link doesn't resolve. */
export type LinkProblem = MissingFile | LineOutOfRange | NameNotOnLine | MissingAnchor;

/** Reads a repo file by its path from the repo root; null when it doesn't exist. */
export type ReadRepoFile = (path: string) => string | null;

const INLINE_LINK = /!?\[((?:[^\]`]|`[^`]*`)*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_SOURCE = /\b(?:src|srcset|href)="([^"]+)"/g;
const CODE_NAME = /^`([A-Za-z_$][\w$]*)`$/;
const LINE_ANCHOR = /^L(\d+)(?:-L(\d+))?$/;

/** Returns every link in a Markdown document, skipping fenced code blocks and inline code. */
export function findLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  let inFence = false;
  for (const [index, raw] of markdown.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Inline code can hold link-like text (a regex, an example); blank it out but keep link texts.
    const line = raw.replace(/(?<!\[)`[^`]*`(?!\])/g, (code) => ' '.repeat(code.length));
    for (const match of line.matchAll(INLINE_LINK)) {
      links.push({ line: index + 1, text: match[1] ?? '', target: match[2] ?? '' });
    }
    for (const match of line.matchAll(HTML_SOURCE)) {
      links.push({ line: index + 1, text: '', target: match[1] ?? '' });
    }
  }
  return links;
}

/** Whether a link points into the repo (not a URL, mail address or in-page anchor only). */
export function isRepoLink(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//');
}

/** Returns GitHub's anchor for a heading: lowercase, punctuation dropped, spaces as dashes. */
export function headingSlug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Returns every anchor a Markdown document defines: its headings (deduplicated) and `<a id>`s. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const slug = headingSlug(heading[1] ?? '');
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) {
      anchors.add(match[1] ?? '');
    }
  }
  return anchors;
}

/** Checks one link from the Markdown file at `fromPath` (both relative to the repo root). */
export function checkLink(
  link: DocLink,
  fromPath: string,
  read: ReadRepoFile,
): Result<void, LinkProblem> {
  const [rawPath = '', anchor = ''] = link.target.split('#', 2);
  const path = rawPath
    ? posix.normalize(posix.join(posix.dirname(fromPath), decodeURIComponent(rawPath)))
    : fromPath;
  const content = read(path);
  if (content === null) return err({ kind: 'missing-file', path });
  if (!anchor) return ok(undefined);

  const lineAnchor = LINE_ANCHOR.exec(anchor);
  if (lineAnchor) {
    const lines = content.split('\n');
    const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
    const first = Number(lineAnchor[1]);
    const last = Number(lineAnchor[2] ?? first);
    if (first < 1 || last > lineCount) {
      return err({ kind: 'line-out-of-range', path, line: last, lineCount });
    }
    const name = CODE_NAME.exec(link.text)?.[1];
    const target = lines.slice(first - 1, last).join('\n');
    if (name && !target.includes(name)) {
      return err({ kind: 'name-not-on-line', path, line: first, name });
    }
    return ok(undefined);
  }

  if (path.endsWith('.md') && !anchorsOf(content).has(decodeURIComponent(anchor))) {
    return err({ kind: 'missing-anchor', path, anchor });
  }
  return ok(undefined);
}

/** Returns the problem as one line of output. */
export function describeProblem(problem: LinkProblem): string {
  switch (problem.kind) {
    case 'missing-file':
      return `${problem.path} doesn't exist`;
    case 'line-out-of-range':
      return `${problem.path} has ${problem.lineCount} lines, not ${problem.line}`;
    case 'name-not-on-line':
      return `${problem.path}:${problem.line} doesn't mention ${problem.name}`;
    case 'missing-anchor':
      return `${problem.path} has no heading or anchor #${problem.anchor}`;
    default:
      return assertNever(problem);
  }
}
