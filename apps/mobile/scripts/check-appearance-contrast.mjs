/** WCAG relative-luminance contrast for the mobile appearance tokens. */

function channel(hex, offset) {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function contrast(foreground, background) {
  const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Keep these hex values aligned with apps/mobile/src/styles.scss. */
export const APPEARANCE_PAIRS = [
  { name: 'dark text on bg', fg: '#ffffff', bg: '#000000', min: 4.5 },
  { name: 'dark secondary on bg', fg: '#99999e', bg: '#000000', min: 4.5 },
  { name: 'dark tertiary on bg', fg: '#949499', bg: '#000000', min: 4.5 },
  { name: 'dark secondary on surface', fg: '#99999e', bg: '#1c1c1e', min: 4.5 },
  { name: 'dark action on bg', fg: '#0a84ff', bg: '#000000', min: 3 },
  { name: 'dark online on bg', fg: '#34c759', bg: '#000000', min: 3 },
  { name: 'light text on bg', fg: '#1c1c1e', bg: '#f2f2f7', min: 4.5 },
  { name: 'light secondary on bg', fg: '#3a3a3c', bg: '#f2f2f7', min: 4.5 },
  { name: 'light tertiary on bg', fg: '#636366', bg: '#ffffff', min: 4.5 },
  { name: 'light text on surface', fg: '#1c1c1e', bg: '#ffffff', min: 4.5 },
  { name: 'light action on bg', fg: '#0040dd', bg: '#f2f2f7', min: 3 },
  { name: 'light online on bg', fg: '#248a3d', bg: '#f2f2f7', min: 3 },
  { name: 'light attention on bg', fg: '#c93400', bg: '#f2f2f7', min: 3 },
  { name: 'light error on bg', fg: '#d70015', bg: '#f2f2f7', min: 3 },
];

export function contrastFailures(pairs = APPEARANCE_PAIRS) {
  return pairs
    .map((pair) => ({ ...pair, ratio: contrast(pair.fg, pair.bg) }))
    .filter((pair) => pair.ratio < pair.min);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = contrastFailures();
  if (failures.length) {
    console.error(failures.map((pair) => `${pair.name}: ${pair.ratio.toFixed(2)} < ${pair.min}`).join('\n'));
    process.exit(1);
  }
  console.log(`Appearance contrast passed (${APPEARANCE_PAIRS.length} pairs).`);
}
