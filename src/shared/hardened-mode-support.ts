/**
 * Which providers may run in WS13 hardened (Seatbelt) mode.
 *
 * Only providers with live evidence of working inside the jail are allowed.
 * Claude was proven in the WS13 live test. Codex is refused (LT-028; a
 * 2026-09-20 run did complete a turn, so it is a re-test candidate). Grok,
 * Cursor, OpenCode, Copilot and Antigravity were never run jailed, so they are
 * refused rather than started in a mode that can hang. Cursor, OpenCode and
 * Copilot keep state outside the current writable roots; Antigravity's state
 * is already below the granted ~/.gemini root but still lacks live evidence.
 * Add a provider here only with live evidence and the writable roots it needs.
 *
 * Shared by the main-process spawn refusal (adapter factory) and the
 * new-session composer, so the two can never disagree.
 */

const HARDENED_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

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
