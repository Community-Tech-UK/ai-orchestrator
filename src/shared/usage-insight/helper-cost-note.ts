/**
 * What extra helper agents cost, in one place so the usage card and the settings
 * rows that limit helpers say the same sentence. Kept apart from the rest of the
 * usage copy so the UI hints check reads only this sentence for a settings row.
 */

export const HELPER_HEAVY_SENTENCE =
  'Each helper agent uses its own allowance, so sessions where helpers do most of the work cost the most.';

/**
 * The settings that limit how many helper agents a session may start. Each helper
 * uses its own allowance, so these rows carry the helper sentence.
 */
const HELPER_LIMIT_SETTING_KEYS: Readonly<Record<string, true | undefined>> = {
  maxChildrenPerParent: true,
  allowNestedOrchestration: true,
  maxSpawnDepth: true,
};

/**
 * The sentence a settings row shows about what extra helpers cost, or null for a
 * setting that has no such cost.
 *
 * @hoverTextReadable every word it can return is a literal in this file, so the UI hints check reads them.
 */
export function settingCostNote(settingKey: string): string | null {
  return HELPER_LIMIT_SETTING_KEYS[settingKey] ? HELPER_HEAVY_SENTENCE : null;
}
