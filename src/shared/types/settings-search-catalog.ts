/**
 * UX4.2 — search that lands on a row, not just a tab.
 *
 * The settings search filtered the nav rail, so typing "context" narrowed the
 * list of tabs and then left you to find the row yourself on whichever one you
 * guessed. This scores individual settings and says which tab each lives on, so
 * a search can jump to the control.
 *
 * **The governing rule is "never land on a row the page cannot edit."** A
 * result that scrolls to nothing is worse than no result, so a key is in the
 * catalog only when a tab genuinely renders it. That is derived, not asserted:
 * the category-driven tabs render `SETTINGS_METADATA` filtered by category and
 * `!hidden`, so `hidden` is exactly the "no generic row" signal, and the one
 * documented exception is listed below with the tab that does render it.
 *
 * No fuzzy-match library: installing a dependency needs sign-off, and
 * `SettingMetadata` has no `keywords` field, so a keyword weight would score
 * against data that does not exist.
 */

import { SETTINGS_METADATA } from './settings.types';
import type { SettingMetadata } from './settings-metadata.types';

/** Tab ids, mirrored structurally — the renderer owns `SettingsTab`. */
export type SettingsSearchTab = string;

/**
 * Which tab renders each category's generic rows.
 *
 * Two of these are not the identity mapping and were checked against the tab
 * components rather than assumed:
 *  - `mcp` renders on **Advanced** (`advanced-settings-tab.component.ts` loops
 *    `store.mcpSettings()`). The `mcp` nav id is the separate MCP server-manager
 *    page, which renders no `SettingMetadata` rows at all.
 *  - `rtk` renders on **rtk-savings**.
 */
const CATEGORY_TAB: Readonly<Record<SettingMetadata['category'], SettingsSearchTab>> = {
  general: 'general',
  orchestration: 'orchestration',
  memory: 'memory',
  display: 'display',
  advanced: 'advanced',
  review: 'review',
  network: 'network',
  mcp: 'advanced',
  rtk: 'rtk-savings',
};

/**
 * Keys hidden from their category's generic listing but rendered by a bespoke
 * tab, which therefore ARE reachable and must stay searchable.
 *
 * The six Computer Use keys are `category: 'mcp'` and `hidden: true` for one
 * reason (S1.5): the Computer Use tab owns them, and without `hidden` the
 * Advanced tab rendered all six a second time. Hidden here means "not in the
 * generic list", not "unreachable" — so excluding them on `hidden` alone would
 * make six real, editable settings permanently unsearchable.
 */
const HIDDEN_BUT_RENDERED: Readonly<Record<string, SettingsSearchTab>> = {
  computerUseEnabled: 'computer-use',
  computerUseAllowedAppsJson: 'computer-use',
  computerUseDeniedAppsJson: 'computer-use',
  computerUseRequireApprovalForInput: 'computer-use',
  computerUseAutonomyLevel: 'computer-use',
  computerUseStoreScreenshotsForEscalations: 'computer-use',
};

export interface SettingsSearchEntry {
  key: string;
  label: string;
  description: string;
  tab: SettingsSearchTab;
}

export interface SettingsSearchMatch extends SettingsSearchEntry {
  score: number;
}

/** Which tab renders this setting, or null when nothing does. */
export function tabForSetting(meta: SettingMetadata): SettingsSearchTab | null {
  const exception = HIDDEN_BUT_RENDERED[meta.key as string];
  if (exception) return exception;
  if (meta.hidden === true) return null;
  return CATEGORY_TAB[meta.category] ?? null;
}

/** Every setting a search is allowed to land on. */
export function settingsSearchCatalog(
  metadata: readonly SettingMetadata[] = SETTINGS_METADATA,
): SettingsSearchEntry[] {
  const out: SettingsSearchEntry[] = [];
  for (const meta of metadata) {
    const tab = tabForSetting(meta);
    if (!tab) continue;
    out.push({ key: meta.key as string, label: meta.label, description: meta.description, tab });
  }
  return out;
}

const LABEL_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;

/**
 * Score one entry against a lowercased query.
 *
 * A label hit outweighs a description hit, and a label that STARTS with the
 * query outweighs one that merely contains it — typing "cont" should reach
 * "Context warning threshold" before something whose description happens to
 * mention context in passing.
 */
function scoreEntry(entry: SettingsSearchEntry, query: string): number {
  const label = entry.label.toLowerCase();
  const description = entry.description.toLowerCase();
  let score = 0;
  if (label === query) score += LABEL_WEIGHT * 3;
  else if (label.startsWith(query)) score += LABEL_WEIGHT * 2;
  else if (label.includes(query)) score += LABEL_WEIGHT;
  if (description.includes(query)) score += DESCRIPTION_WEIGHT;
  return score;
}

/**
 * Rank the catalog against a query, best first.
 *
 * A blank or whitespace-only query returns nothing rather than everything: an
 * empty search box means "not searching", and returning 130 rows would make the
 * jump affordance appear the moment the field is focused.
 */
export function searchSettings(
  query: string,
  catalog: readonly SettingsSearchEntry[] = settingsSearchCatalog(),
): SettingsSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return catalog
    .map((entry) => ({ ...entry, score: scoreEntry(entry, needle) }))
    .filter((m) => m.score > 0)
    // Ties broken by label so the "best match" a caller jumps to is stable
    // between renders rather than depending on metadata declaration order.
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** The single row a "jump to" affordance should target, if any. */
export function bestSettingMatch(
  query: string,
  catalog: readonly SettingsSearchEntry[] = settingsSearchCatalog(),
): SettingsSearchMatch | null {
  return searchSettings(query, catalog)[0] ?? null;
}
