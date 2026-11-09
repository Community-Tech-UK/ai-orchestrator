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

  it('shows and hides the project actions without moving them', () => {
    // Reported 2026-11-08: a 6px slide on the hidden actions pushed them past
    // the list's right edge, so the session list scrolled and shifted sideways.
    // A transform while shown also breaks the fixed-position menu (LT-631).
    const blocks = [...scss.matchAll(/([^{}]*\.project-actions[^{}]*)\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      expect(body, selector.trim()).not.toMatch(/(^|[\s;])(transform|translate|rotate|scale)\s*:/);
    }
  });

  it('turns the project arrow inside a square box, so it never reaches past the row', () => {
    const block = /\.project-chevron\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    const width = /(^|[\s;])width:\s*([^;]+);/.exec(block)?.[2];
    const height = /(^|[\s;])height:\s*([^;]+);/.exec(block)?.[2];
    expect(width).toBeDefined();
    expect(height).toBe(width);
  });

  it('lets indented ended sessions fill the rest of the row instead of a full extra width', () => {
    // Nested history rows are indented with margin-left; width: 100% on top of
    // that pushed them past the list's right edge (reported 2026-11-08).
    expect(html).toMatch(/class="history-entry"[\s\S]{0,400}\[style\.margin-left\.px\]="depth \* 18"/);
    const block = /\.history-entry\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    expect(block).toMatch(/display:\s*grid/);
    expect(block).not.toMatch(/(^|[\s;])width\s*:\s*100%/);
  });

  it('keeps the dropdown scrollable, so a tall Copilot list stays reachable', () => {
    const block = /\.project-menu\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    expect(block).toMatch(/max-height:/);
    expect(block).toMatch(/overflow:\s*hidden auto/);
  });
});

describe('session list width', () => {
  it('sizes the list to the sidebar, not to its widest row', () => {
    // Reported 2026-11-08: the container sits in the flex :host, so without
    // min-width: 0 a row with change counts made the whole list wider than the
    // sidebar, which clipped the row buttons and shifted as rows changed.
    expect(scss).toMatch(/:host\s*\{[^}]*display:\s*flex/);
    const block = /\.instance-list-container\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    expect(block).toMatch(/(^|[\s;])min-width:\s*0\s*;/);
  });

  it('puts the attention filters on their own line, so the search box keeps its room', () => {
    // Last in the bar, so keyboard and screen-reader order match the layout.
    const bar = html.slice(html.indexOf('class="filter-bar"'), html.indexOf('<app-instance-list-load-failure'));
    expect(bar.indexOf('<app-session-attention-tabs')).toBeGreaterThan(bar.indexOf('class="filters-anchor"'));
    expect(bar.indexOf('class="filters-anchor"')).toBeGreaterThan(bar.indexOf('class="filter-input"'));
    expect(/\.filter-bar\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '').toMatch(/flex-wrap:\s*wrap/);
    const block = /\.filter-bar > app-session-attention-tabs\s*\{([^}]*)\}/.exec(scss)?.[1] ?? '';
    expect(block).toMatch(/flex-basis:\s*100%/);
  });
});
