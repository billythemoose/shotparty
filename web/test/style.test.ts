import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('hidden elements stay hidden', () => {
  it('has a global [hidden] rule that beats class display rules', () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('the elements the page toggles with `hidden` exist and start hidden', () => {
    for (const id of ['pin-field', 'uploader', 'blocked', 'progress', 'thanks', 'retry-failed']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*\\shidden`));
    }
  });
});
