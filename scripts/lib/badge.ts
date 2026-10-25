/**
 * @fileoverview A shields.io-style "coverage | NN%" badge, drawn locally so the README needs no
 * badge service.
 */

/** Same color steps as shields.io's coverage badges. */
export function badgeColor(pct: number): string {
  if (pct >= 90) return '#4c1';
  if (pct >= 75) return '#97ca00';
  if (pct >= 60) return '#a4a61d';
  if (pct >= 45) return '#dfb317';
  if (pct >= 30) return '#fe7d37';
  return '#e05d44';
}

/** Returns the badge as SVG text. */
export function coverageBadgeSvg(pct: number): string {
  const value = `${Math.floor(pct)}%`;
  const labelW = 61;
  const valueW = 11 + value.length * 7; // Verdana 11px digits are ~7px wide
  const w = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="coverage: ${value}">
  <title>coverage: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${badgeColor(pct)}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">coverage</text>
    <text x="${labelW / 2}" y="14">coverage</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>
`;
}
