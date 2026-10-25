import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accentVariables,
  applyDisplay,
  contrastRatio,
  DARK_BG,
  DEFAULT_HEADLINE,
  DEFAULT_WELCOME,
  LIGHT_BG,
  readableAccent,
  textOn,
  thanksMessage,
} from '../src/display';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

describe('accent colors', () => {
  it('uses the same page backgrounds as style.css', () => {
    expect(css).toContain(`--bg: ${LIGHT_BG};`);
    expect(css).toContain(`--bg: ${DARK_BG};`);
  });

  it('keeps a color that already stands out unchanged', () => {
    expect(readableAccent('#1a5fb4', LIGHT_BG)).toBe('#1a5fb4');
    expect(readableAccent('#ffbe6f', DARK_BG)).toBe('#ffbe6f');
  });

  it.each(['#ffff00', '#fdf6e3', '#ffffff', '#000080', '#000000', '#7f7f7f'])(
    'makes %s stand out on both backgrounds',
    (hex) => {
      expect(contrastRatio(readableAccent(hex, LIGHT_BG), LIGHT_BG)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(readableAccent(hex, DARK_BG), DARK_BG)).toBeGreaterThanOrEqual(3);
    },
  );

  it('darkens a pale color on the light page and lightens a dark one on the dark page', () => {
    const paleOnLight = readableAccent('#ffff00', LIGHT_BG);
    const navyOnDark = readableAccent('#000080', DARK_BG);
    expect(contrastRatio(paleOnLight, '#000000')).toBeLessThan(contrastRatio('#ffff00', '#000000'));
    expect(contrastRatio(navyOnDark, '#ffffff')).toBeLessThan(contrastRatio('#000080', '#ffffff'));
  });

  it('picks readable button text', () => {
    expect(textOn('#1a5fb4')).toBe('#ffffff');
    expect(textOn('#ffbe6f')).toBe('#111113');
  });

  it('sets nothing for a missing or malformed color (the theme default applies)', () => {
    expect(accentVariables(undefined)).toEqual({});
    expect(accentVariables('red')).toEqual({});
    expect(accentVariables('#12345')).toEqual({});
  });

  it('sets a color and text color per scheme, matching the names style.css reads', () => {
    const vars = accentVariables('#1a5fb4');
    expect(Object.keys(vars)).toEqual([
      '--event-accent-light',
      '--event-accent-fg-light',
      '--event-accent-dark',
      '--event-accent-fg-dark',
    ]);
    for (const name of Object.keys(vars)) {
      expect(css).toContain(`var(${name},`);
    }
  });
});

describe('thanksMessage', () => {
  it('uses the default or the event’s own thanks', () => {
    expect(thanksMessage(3, 0)).toBe('All 3 uploaded. Thank you! Add more any time.');
    expect(thanksMessage(3, 0, 'See you next year!')).toBe(
      'All 3 uploaded. See you next year! Add more any time.',
    );
    expect(thanksMessage(2, 1, 'Cheers!')).toBe("2 uploaded. Cheers! 1 couldn't be uploaded.");
  });
});

describe('applyDisplay', () => {
  interface FakeDocument {
    doc: Document;
    els: Record<string, { textContent: string }>;
    style: Record<string, string>;
  }

  function fakeDocument(): FakeDocument {
    const els: Record<string, { textContent: string }> = {
      '#event-name': { textContent: '' },
      '#headline': { textContent: '' },
      '#welcome': { textContent: '' },
    };
    const style: Record<string, string> = {};
    const doc = {
      title: '',
      querySelector: (sel: string) => els[sel] ?? null,
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => {
            style[k] = v;
          },
        },
      },
    };
    return { doc: doc as unknown as Document, els, style };
  }

  it('shows the neutral defaults when the event sets nothing', () => {
    const { doc, els, style } = fakeDocument();
    applyDisplay(doc, 'Summer Party');
    expect(els['#event-name']!.textContent).toBe('Summer Party');
    expect(els['#headline']!.textContent).toBe(DEFAULT_HEADLINE);
    expect(els['#welcome']!.textContent).toBe(DEFAULT_WELCOME);
    expect(doc.title).toBe(`${DEFAULT_HEADLINE} · Summer Party`);
    expect(style).toEqual({});
  });

  it('shows the event’s own text (as text, never HTML) and color', () => {
    const { doc, els, style } = fakeDocument();
    applyDisplay(doc, 'Launch Night', {
      headline: 'Say cheese',
      welcome: '<img src=x onerror=alert(1)>',
      accentColor: '#1a5fb4',
    });
    expect(els['#headline']!.textContent).toBe('Say cheese');
    expect(els['#welcome']!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(doc.title).toBe('Say cheese · Launch Night');
    expect(style['--event-accent-light']).toBe('#1a5fb4');
  });
});
