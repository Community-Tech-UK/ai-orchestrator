/**
 * Which providers may run in WS13 hardened (Seatbelt) mode.
 *
 * A provider is listed only with live evidence of it working inside the jail.
 * The 2026-09-28 hardened probe ran each CLI the way Harness launches it,
 * under the shipped base policy: Claude, Codex and Antigravity completed a turn
 * with the shared default roots, and Grok, OpenCode and Cursor did with their
 * `providerHardenedWritableRoots` (src/main/sandbox/seatbelt.ts). In every run
 * the workspace write succeeded and a `~/Desktop` write was blocked. Copilot
 * started, authenticated and reached the model API inside the jail with its
 * account home granted. Its tool turn is still unproven, because the only
 * non-EBRD account had no premium requests left until 2026-10-01.
 *
 * The legacy `gemini` CLI alias was never run jailed and stays refused.
 *
 * Shared by the main-process spawn refusal (adapter factory) and the
 * new-session composer, so the two can never disagree.
 */

const HARDENED_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'antigravity', 'grok', 'opencode', 'cursor', 'copilot',
]);

const PROVIDER_SHORT_NAMES: Readonly<Record<string, string>> = {
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
  ollama: 'Ollama',
};

export function isHardenedModeSupported(provider: string): boolean {
  return HARDENED_SUPPORTED_PROVIDERS.has(provider);
}

export function hardenedProviderName(provider: string): string {
  return PROVIDER_SHORT_NAMES[provider] ?? provider;
}

export function hardenedModeUnsupportedMessage(provider: string): string {
  return `Hardened mode is not supported for ${hardenedProviderName(provider)} yet. `
    + 'Start this session without hardened mode, or use Claude.';
}
