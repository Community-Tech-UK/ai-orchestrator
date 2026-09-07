/**
 * S3.2 — Common vs Advanced, computed rather than curated.
 *
 * Every category-driven settings tab rendered one flat list, so a numeric
 * tuning knob nobody touches sat at the same weight as the toggle people
 * actually came for. The fix is a tier per row — but a second hand-maintained
 * registry of ~200 keys is the thing that rots: it would be exhaustive on the
 * day it was written and wrong a month later, and nothing would fail when it
 * drifted.
 *
 * So the tier is DERIVED from metadata that already exists and is already
 * maintained, `SettingMetadata.type`. A number is a tuning knob; everything else
 * is a choice. That rule is wrong for a small, nameable set of ports — which is
 * why they are listed explicitly rather than the rule being softened into
 * something unfalsifiable.
 */

import type { SettingMetadata } from './settings-metadata.types';

export type SettingTier = 'common' | 'advanced';

/**
 * Numeric settings that are basic connectivity, not tuning.
 *
 * A port is a number, but "which port does this listen on" is the first thing
 * someone configuring a connection needs, not an expert knob. Named individually
 * because the alternative — exempting every key matching `/Port$/` — would
 * silently capture future timeout and retry-count keys that genuinely are
 * advanced.
 */
const COMMON_NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'remoteNodesServerPort',
  'thinClientWsPort',
  'mobileGatewayPort',
]);

export function settingTier(meta: SettingMetadata): SettingTier {
  if (meta.type !== 'number') return 'common';
  return COMMON_NUMERIC_KEYS.has(meta.key as string) ? 'common' : 'advanced';
}

export interface TieredSettings {
  common: SettingMetadata[];
  advanced: SettingMetadata[];
}

/**
 * Split a list into its two tiers, preserving the caller's order within each.
 *
 * Order is preserved deliberately: the tabs already order their rows
 * meaningfully, and re-sorting here would quietly reshuffle every migrated tab
 * as a side effect of adding a collapse.
 */
export function splitByTier(settings: readonly SettingMetadata[]): TieredSettings {
  const common: SettingMetadata[] = [];
  const advanced: SettingMetadata[] = [];
  for (const meta of settings) {
    (settingTier(meta) === 'advanced' ? advanced : common).push(meta);
  }
  return { common, advanced };
}

/**
 * Label for the disclosure control.
 *
 * States the count, because "Show advanced" alone gives no sense of whether
 * something is hidden behind it worth opening.
 */
export function advancedToggleLabel(count: number, expanded: boolean): string {
  if (expanded) return 'Hide advanced settings';
  return `${count} more advanced setting${count === 1 ? '' : 's'} — Show advanced`;
}
