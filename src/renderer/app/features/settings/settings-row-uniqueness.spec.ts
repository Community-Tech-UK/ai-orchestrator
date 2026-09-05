/**
 * S1.5 — a setting must have exactly one canonical home.
 *
 * The Advanced tab renders whole CATEGORIES, and every `computerUse*` key is
 * `category: 'mcp'`, so all six were rendered there AND on the dedicated
 * Computer Use tab. Two rows for one value: change it in one place and the
 * other is stale until you navigate away and back.
 *
 * This guards the rule generically rather than the six keys specifically, so a
 * new setting that lands in both a category listing and a bespoke tab fails
 * here rather than shipping duplicated.
 */
import { describe, expect, it } from 'vitest';

import { SETTINGS_METADATA } from '../../../../shared/types/settings.types';

/** Keys a bespoke tab claims by explicit name. */
const BESPOKE_TAB_KEYS: Record<string, readonly string[]> = {
  'computer-use': [
    'computerUseEnabled',
    'computerUseAllowedAppsJson',
    'computerUseDeniedAppsJson',
    'computerUseRequireApprovalForInput',
    'computerUseStoreScreenshotsForEscalations',
    'computerUseAutonomyLevel',
  ],
};

describe('settings rows have one canonical home (S1.5)', () => {
  const byKey = new Map<string, (typeof SETTINGS_METADATA)[number]>(
    SETTINGS_METADATA.map((m) => [m.key as string, m]),
  );

  for (const [tab, keys] of Object.entries(BESPOKE_TAB_KEYS)) {
    it(`keys owned by the ${tab} tab are excluded from generic category listings`, () => {
      const leaked: string[] = [];
      for (const key of keys) {
        const meta = byKey.get(key);
        expect(meta, `${key} is missing from SETTINGS_METADATA`).toBeTruthy();
        // A category-driven tab renders `category === X && !hidden`, so a
        // bespoke-owned key must be hidden or it renders in both places.
        if (meta && !meta.hidden) leaked.push(key);
      }
      expect(leaked).toEqual([]);
    });

    it(`every key the ${tab} tab claims actually exists`, () => {
      const missing = keys.filter((k) => !byKey.has(k));
      expect(missing).toEqual([]);
    });
  }

  it('metadata keys are unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const meta of SETTINGS_METADATA) {
      if (seen.has(meta.key)) dupes.push(meta.key);
      seen.add(meta.key);
    }
    expect(dupes).toEqual([]);
  });
});
