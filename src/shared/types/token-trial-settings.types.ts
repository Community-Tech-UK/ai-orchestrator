/**
 * Switches for the Oct-2 Phase D helper-cost trials. A trial assigns a session or task to a group once, from a
 * stable key, and keeps it there for the whole life of that session, so changing a switch affects sessions started
 * afterwards. The default is a literal in `settings-defaults.ts` (that module is in the context worker's import
 * closure and takes no runtime imports). Claude's helper-agent model and RTK's auto-approve scope are in
 * `TokenLeverSettings`.
 */

/** Codex plan-queue checkers: Codex's automatic skills list kept, left out, or half and half by plan item. */
export type CodexCheckerSkillCatalogSetting = 'trial' | 'full' | 'omit';

export interface TokenTrialSettings {
  codexCheckerSkillCatalog: CodexCheckerSkillCatalogSetting;
}
