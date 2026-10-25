import { describe, expect, it } from 'vitest';
import { badgeColor, coverageBadgeSvg } from '../lib/badge.js';

describe('coverage badge', () => {
  it('shows the whole-number percentage, rounded down', () => {
    const svg = coverageBadgeSvg(45.97);
    expect(svg).toContain('aria-label="coverage: 45%"');
    expect(svg).not.toContain('46%');
  });

  it('colors by the shields.io steps', () => {
    expect(badgeColor(29.9)).toBe('#e05d44');
    expect(badgeColor(45)).toBe('#dfb317');
    expect(badgeColor(90)).toBe('#4c1');
    expect(coverageBadgeSvg(80)).toContain('fill="#97ca00"');
  });

  it('widens for 100%', () => {
    const width = (svg: string): number => Number(/width="(\d+)"/.exec(svg)![1]);
    expect(width(coverageBadgeSvg(100))).toBeGreaterThan(width(coverageBadgeSvg(99)));
  });
});
