import type { PickerProvider } from './compact-model-picker.types';

/**
 * Default chat-side provider order. Excludes `auto` (picker always pins a
 * concrete provider) and `cursor` (chats don't currently support cursor).
 */
export const DEFAULT_CHAT_PROVIDERS: PickerProvider[] = ['claude', 'codex', 'antigravity', 'copilot'];

/** Full provider order used by new-session and instance-draft surfaces. */
export const DEFAULT_INSTANCE_PROVIDERS: PickerProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'copilot',
  'cursor',
  'grok',
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
  'local-model': '#14b8a6',
};
