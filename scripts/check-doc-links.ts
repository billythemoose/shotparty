/**
 * @fileoverview Fails when a relative link in the repo's Markdown doesn't resolve (see
 * scripts/lib/doc-links.ts for what's checked). Covers tracked and untracked, non-ignored files.
 *
 *   npm run lint:docs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { checkLink, describeProblem, findLinks, isRepoLink } from './lib/doc-links.js';

function readRepoFile(path: string): string | null {
  try {
    // A link to a folder is fine (GitHub shows its listing or README).
    return statSync(path).isDirectory() ? '' : readFileSync(path, 'utf8');
  } catch {
    // Missing (or unreadable): reported as a missing file.
    return null;
  }
}

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f !== '' && readRepoFile(f) !== null);

let links = 0;
const problems: string[] = [];
for (const file of files) {
  for (const link of findLinks(readRepoFile(file) ?? '')) {
    if (!isRepoLink(link.target)) continue;
    links++;
    const result = checkLink(link, file, readRepoFile);
    if (!result.ok) {
      problems.push(`${file}:${link.line}: ${link.target}: ${describeProblem(result.error)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} broken link(s) out of ${links} in ${files.length} files.`);
  process.exit(1);
}
console.log(`All ${links} relative links in ${files.length} Markdown files resolve.`);
