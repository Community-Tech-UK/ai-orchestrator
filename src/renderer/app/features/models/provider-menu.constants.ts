import type { PickerProvider } from './compact-model-picker.types';

/**
 * Default chat-side provider order for the MAIN chat surface. Sidechats use
 * `SIDECAT_CHAT_PROVIDERS` which includes the wider set. Excludes `auto`.
 */
export const DEFAULT_CHAT_PROVIDERS: PickerProvider[] = [
  'claude', 'codex', 'antigravity', 'copilot',
];

/**
 * Sidechat provider order: every session provider with a working conversation
 * runtime, including OpenCode, Grok, Cursor and local models.
 */
export const SIDECAT_CHAT_PROVIDERS: PickerProvider[] = [
  'claude', 'codex', 'antigravity', 'copilot', 'grok', 'opencode', 'cursor', 'local-model',
];

/** Full provider order used by new-session and instance-draft surfaces. */
export const DEFAULT_INSTANCE_PROVIDERS: PickerProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'copilot',
  'cursor',
  'grok',
  'opencode',
  'local-model',
];

export const PROVIDER_MENU_LABELS: Record<PickerProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
  'local-model': 'Local Models',
};

export const PROVIDER_MENU_COLORS: Record<PickerProvider, string> = {
  claude: '#d97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  antigravity: '#00b8d4',
  copilot: '#b8865f',
  // Cursor's mark is monochrome; the theme foreground token stays legible on
  // both dark and light themes when consumed via `[style.color]`.
  cursor: 'var(--text-primary)',
  grok: '#1da1f2',
  // Neutral: OpenCode fronts many backends, so it borrows no vendor colour.
  opencode: 'var(--text-secondary)',
  'local-model': '#14b8a6',
};
