/**
 * S2.2 — stage helpers.
 *
 * The registry field lives on `SettingMetadata`; these are the rules for using
 * it, kept pure so the UI and any lint agree rather than each inventing their
 * own reading of what "deprecated" should do.
 */

import type { SettingMetadata, SettingStage } from './settings-metadata.types';

export const DEFAULT_STAGE: SettingStage = 'stable';

export function stageOf(meta: Pick<SettingMetadata, 'stage'>): SettingStage {
  return meta.stage ?? DEFAULT_STAGE;
}

/**
 * A `removed` setting must not be offered at all: showing a control that can
 * never do anything is the "dead control" the tooltip house rules say to delete
 * rather than explain.
 */
export function isOfferable(meta: Pick<SettingMetadata, 'stage'>): boolean {
  return stageOf(meta) !== 'removed';
}

/** Stages that need a visible caveat next to the control. */
const NEEDS_CAVEAT: ReadonlySet<SettingStage> = new Set([
  'under-development',
  'experimental',
  'deprecated',
]);

export function needsStageCaveat(meta: Pick<SettingMetadata, 'stage'>): boolean {
  return NEEDS_CAVEAT.has(stageOf(meta));
}

/**
 * Operator-facing caveat. Says what it means for THEM, not what the stage is
 * called — "Experimental" alone tells a user nothing about whether to touch it.
 */
export function stageCaveat(meta: Pick<SettingMetadata, 'stage'>): string | null {
  switch (stageOf(meta)) {
    case 'under-development':
      return 'Being built. It may not work yet, and it can change without notice.';
    case 'experimental':
      return 'Experimental. It works, but the behaviour may change and it is less tested.';
    case 'deprecated':
      return 'Deprecated. It still works today but is going away; avoid relying on it.';
    case 'removed':
      return 'Removed. This setting no longer does anything.';
    case 'stable':
      return null;
  }
}

export interface SettingBadge {
  text: string;
  /** Longer explanation for a tooltip or inline hint. */
  detail: string;
}

/**
 * Every badge a setting should carry, in a stable order.
 *
 * Order matters and is not alphabetical: stage first (is this safe to touch),
 * then restart (will it appear to do nothing), then dependency (will it do
 * nothing until something else is on). That is the order a person needs them.
 */
export function badgesFor(
  meta: Pick<SettingMetadata, 'stage' | 'requiresRestart' | 'dependsOn'>,
): SettingBadge[] {
  const badges: SettingBadge[] = [];
  const caveat = stageCaveat(meta);
  if (caveat && needsStageCaveat(meta)) {
    badges.push({ text: stageOf(meta).replace('-', ' '), detail: caveat });
  }
  if (meta.requiresRestart) {
    badges.push({
      text: 'restart required',
      detail: 'Takes effect after you restart the app, not immediately.',
    });
  }
  if (meta.dependsOn) {
    badges.push({
      text: `requires ${String(meta.dependsOn)}`,
      detail: `This does nothing unless ${String(meta.dependsOn)} is enabled.`,
    });
  }
  return badges;
}

/**
 * Search terms for a setting: its own words plus any declared keywords.
 *
 * Lower-cased once here so a caller does not re-normalise per keystroke, and so
 * two search implementations cannot disagree about case.
 */
export function searchTermsFor(meta: SettingMetadata): string {
  return [meta.key, meta.label, meta.description, ...(meta.keywords ?? [])]
    .join(' ')
    .toLowerCase();
}

export function matchesSearch(meta: SettingMetadata, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = searchTermsFor(meta);
  // Every word must appear: "loop cost" should not match a setting that only
  // mentions loops, or a search is noise rather than a filter.
  return trimmed.split(/\s+/).every((word) => haystack.includes(word));
}
