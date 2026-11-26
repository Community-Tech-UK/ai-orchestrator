import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(process.cwd(), 'src/renderer/app');
function templates(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? templates(path) : /\.(html|ts)$/.test(path) && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const backdrops = templates(rendererRoot).flatMap((path) => {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(/<button\b[^>]*>/gs)]
    .filter(([tag]) => /\bclass="[^"]*(?:scrim|backdrop)[^"]*"/.test(tag))
    .map(([tag]) => ({ path: path.slice(rendererRoot.length + 1), tag }));
});

describe('invisible backdrop buttons', () => {
  // No exceptions: each backdrop has a visible close control or Escape route.
  // Inventory is the merged renderer's scrim/backdrop buttons (session
  // artifacts strip, instance header, session progress panel, child
  // diagnostic bundle, both settings scrims, node picker, recent
  // directories dropdown, help drawer, context details popover, session
  // options menu).
  it('keeps the inventory present so the guard cannot pass vacuously', () => {
    expect(backdrops).toHaveLength(11);
  });
  it.each(backdrops)('$path removes the scrim from keyboard and screen-reader navigation', ({ tag }) => {
    expect(tag).toContain('tabindex="-1"');
    expect(tag).toContain('aria-hidden="true"');
  });
});
