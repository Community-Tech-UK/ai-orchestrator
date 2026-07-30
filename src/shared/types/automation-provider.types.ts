/**
 * Provider ids that the app's automatic-selection machinery can choose between,
 * and their display labels.
 *
 * This is the vocabulary of `providersExcludedFromAutomation`: the union of every
 * provider that appears in an automatic preference list (`resolveCliType`'s
 * fallback priority, the scaffolding and magic-prompt preferences, the consensus
 * and verification fan-outs, and the ping-pong reviewer pool). It is deliberately
 * wider than `REMOTE_REVIEWER_PROVIDER_IDS`, which covers reviewers only.
 *
 * Ids are the CLI detection names, NOT the reviewer vocabulary — `gemini` and
 * `antigravity` are separate CLIs here (`gemini` vs `agy`) and are never folded
 * together, so excluding one does not exclude the other.
 */
export const AUTOMATION_PROVIDER_IDS = [
  'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'ollama',
] as const;

export type AutomationProviderId = typeof AUTOMATION_PROVIDER_IDS[number];

export const AUTOMATION_PROVIDER_DEFINITIONS: readonly {
  id: AutomationProviderId;
  label: string;
}[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'ollama', label: 'Ollama' },
] as const;
