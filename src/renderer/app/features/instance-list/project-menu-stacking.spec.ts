import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Reported 2026-08-31: hovering an open project dropdown showed ANOTHER
 * project's row controls (`+ ⋯ ⌄`) painting straight through it.
 *
 * Cause: `.project-header-row` is `position: relative; z-index: 1`, so every
 * row is its own stacking context. The dropdown's `z-index: 100` therefore only
 * ranks it WITHIN its own row; two rows both at `z-index: 1` fall back to DOM
 * order, and a project lower in the list wins.
 *
 * These assertions pin the invariant — the row owning the open menu must
 * outrank its siblings. They cannot prove real paint order; that needs a live
 * window, and is recorded as a live check.
 */
const DIR = join(__dirname);
const scss = readFileSync(join(DIR, 'instance-list.component.scss'), 'utf8');
const html = readFileSync(join(DIR, 'instance-list.component.html'), 'utf8');

/** z-index declared on a selector, or null when the block has none. */
function zIndexOf(selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(scss);
  if (!block) throw new Error(`selector not found in stylesheet: ${selector}`);
  const found = /z-index:\s*(-?\d+)/.exec(block[1]);
  return found ? Number(found[1]) : null;
}

describe('project dropdown stacking', () => {
  it('gives the row owning the open menu a higher z-index than a plain row', () => {
    const plain = zIndexOf('.project-header-row');
    const open = zIndexOf('.project-header-row.menu-open');
    expect(plain, 'the base row is expected to establish a stacking context').not.toBeNull();
    expect(open, 'the open row must declare its own z-index').not.toBeNull();
    expect(open as number).toBeGreaterThan(plain as number);
  });

  it('binds that class to the project whose menu is actually open', () => {
    // A z-index rule nothing applies is the same bug with extra steps.
    expect(html).toMatch(/\[class\.menu-open\]="openProjectMenuKey\(\) === group\.key"/);
  });

  it('keeps the dropdown scrollable, so a tall Copilot list stays reachable', () => {
    const block = /\.project-menu\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    expect(block).toMatch(/max-height:/);
    expect(block).toMatch(/overflow:\s*hidden auto/);
  });
});
