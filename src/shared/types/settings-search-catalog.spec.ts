/**
 * UX4.2 — the catalog's whole value depends on one property: **every entry is a
 * row some tab actually renders.** A search that scrolls to nothing is worse
 * than a search that finds nothing, so the load-bearing test here is the last
 * one, which checks the catalog against the tab components themselves rather
 * than against a hand-written list of what the author believed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  bestSettingMatch,
  searchSettings,
  settingsSearchCatalog,
  tabForSetting,
  type SettingsSearchEntry,
} from './settings-search-catalog';
import { SETTINGS_METADATA } from './settings.types';
import type { SettingMetadata } from './settings-metadata.types';

function meta(over: { key: string } & Partial<Omit<SettingMetadata, 'key'>>): SettingMetadata {
  return {
    label: 'A setting',
    description: 'What it does',
    type: 'boolean',
    category: 'general',
    ...over,
  } as unknown as SettingMetadata;
}

const entry = (over: Partial<SettingsSearchEntry> = {}): SettingsSearchEntry => ({
  key: 'k', label: 'Label', description: 'Description', tab: 'general', ...over,
});

describe('tabForSetting', () => {
  it('maps a category to its own tab', () => {
    expect(tabForSetting(meta({ key: 'a', category: 'memory' }))).toBe('memory');
  });

  it('sends `mcp`-category settings to Advanced, which is the tab that renders them', () => {
    expect(tabForSetting(meta({ key: 'a', category: 'mcp' }))).toBe('advanced');
  });

  it('sends `rtk`-category settings to rtk-savings', () => {
    expect(tabForSetting(meta({ key: 'a', category: 'rtk' }))).toBe('rtk-savings');
  });

  it('excludes a hidden setting, because no generic list renders it', () => {
    expect(tabForSetting(meta({ key: 'a', hidden: true }))).toBeNull();
  });

  it('keeps the Computer Use keys, which are hidden from Advanced but rendered by their own tab', () => {
    expect(tabForSetting(meta({ key: 'computerUseEnabled', category: 'mcp', hidden: true })))
      .toBe('computer-use');
  });
});

describe('searchSettings', () => {
  const catalog = [
    entry({ key: 'theme', label: 'Theme', description: 'Colour scheme' }),
    entry({ key: 'ctx', label: 'Context warning threshold', description: 'Warn near the limit' }),
    entry({ key: 'other', label: 'Something else', description: 'Mentions context in passing' }),
  ];

  it('returns nothing for an empty query, so the jump affordance stays hidden', () => {
    expect(searchSettings('', catalog)).toEqual([]);
    expect(searchSettings('   ', catalog)).toEqual([]);
  });

  it('ranks a label prefix above a description mention', () => {
    const results = searchSettings('context', catalog);
    expect(results.map((r) => r.key)).toEqual(['ctx', 'other']);
  });

  it('ranks an exact label highest', () => {
    const results = searchSettings('theme', catalog);
    expect(results[0]?.key).toBe('theme');
  });

  it('is case-insensitive', () => {
    expect(searchSettings('THEME', catalog)[0]?.key).toBe('theme');
  });

  it('excludes non-matches entirely rather than scoring them zero', () => {
    expect(searchSettings('nothing-matches-this', catalog)).toEqual([]);
  });

  it('breaks ties by label so the jump target is stable between renders', () => {
    const tied = [
      entry({ key: 'b', label: 'Zebra mode', description: 'x' }),
      entry({ key: 'a', label: 'Alpha mode', description: 'x' }),
    ];
    expect(searchSettings('mode', tied).map((r) => r.key)).toEqual(['a', 'b']);
  });

  it('carries the tab through, which is the whole point', () => {
    expect(searchSettings('theme', catalog)[0]?.tab).toBe('general');
  });
});

describe('bestSettingMatch', () => {
  it('is the top-ranked result over the real metadata', () => {
    // Anchored to the real label rather than a guessed one: an earlier version
    // of this test invented "Context warning threshold" and failed against the
    // shipped "Context-full warning at".
    expect(bestSettingMatch('Context-full warning at')?.key).toBe('contextWarningThreshold');
  });

  it('is null when nothing matches', () => {
    expect(bestSettingMatch('zzzzz-no-such-setting')).toBeNull();
  });
});

describe('the catalog only lands on rows that exist', () => {
  it('covers the real metadata without throwing', () => {
    expect(settingsSearchCatalog().length).toBeGreaterThan(50);
  });

  /**
   * The one that matters — and the version before it passed for the wrong
   * reason, so the failure mode is worth stating.
   *
   * That version asked whether the tab's SOURCE contained the store selector
   * for the key's category. It always does: the selector is the base call that
   * a tab's exclusion filter is applied to. So a key the tab deliberately
   * filtered OUT of its generic row loop, and rendered instead through a
   * bespoke control, still passed — and settings search would switch tabs,
   * search the DOM for six frames, find nothing and silently give up. Exactly
   * the "lands on a row the page cannot edit" failure the catalog exists to
   * prevent. Seven real keys were in that state (theme, font size, density,
   * sidebar style, default provider/model, the reviewer list).
   *
   * The rule now: a catalogued key must be reachable in the DOM, which means
   * either a generic `<app-setting-row>` (whose host binding emits
   * `data-setting-key` automatically) or an explicit `data-setting-key` on the
   * bespoke control that stands in for its row. A tab that NAMES a key in a
   * filter must therefore also anchor it — naming it is the signal that it is
   * not coming from the generic loop.
   */
  it('every key its tab EXCLUDES from the generic loop carries a search anchor', () => {
    const dir = join(__dirname, '..', '..', 'renderer', 'app', 'features', 'settings');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.html'));
    const sourceByTab = new Map<string, string>();
    for (const f of files) {
      const tab = f.replace(/-settings-tab\.component\.(ts|html)$/, '')
        .replace(/-tab\.component\.(ts|html)$/, '')
        .replace(/\.component\.(ts|html)$/, '');
      sourceByTab.set(tab, (sourceByTab.get(tab) ?? '') + readFileSync(join(dir, f), 'utf8'));
    }

    /**
     * The two ways a tab in this codebase drops a key from its generic loop.
     * Naming a key is NOT enough on its own — `advanced` and `computer-use`
     * name keys to INCLUDE them, and those still render as generic rows.
     */
    const isExcluded = (source: string, key: string): boolean => {
      // Pulled out of the list to be rendered in its own `<app-setting-row>`
      // (network's pause toggle) — still a generic row, still anchored by the
      // row's own host binding.
      if (new RegExp(`===\\s*'${key}'`).test(source)) return false;
      if (new RegExp(`!==\\s*'${key}'`).test(source)) return true;
      const inNegatedSet = /![\w.]*\.has\(/.test(source)
        && new RegExp(`new Set<[^>]*>\\(\\[[^\\]]*'${key}'`, 's').test(source);
      return inNegatedSet;
    };

    const unreachable = settingsSearchCatalog().filter((entry) => {
      const source = sourceByTab.get(entry.tab);
      if (!source) return true;
      if (!isExcluded(source, entry.key)) return false;
      return !source.includes(`data-setting-key="${entry.key}"`);
    }).map((e) => `${e.key} on ${e.tab}`);

    expect(unreachable).toEqual([]);
  });

  it('the generic row primitive emits the anchor the scroll looks for', () => {
    // If this host binding is ever removed, every generically-rendered key
    // silently stops being reachable and the test above still passes.
    const row = readFileSync(
      join(__dirname, '..', '..', 'renderer', 'app', 'features', 'settings', 'setting-row.component.ts'),
      'utf8',
    );
    expect(row).toContain("'[attr.data-setting-key]': 'setting().key'");
  });
});
