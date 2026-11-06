import { providerName } from '../../../../shared/display-names';
import type { PickerProvider } from './compact-model-picker.types';

/**
 * Default chat-side provider order for the MAIN chat surface. Sidechats use
 * `SIDE_CHAT_MENU_PROVIDERS` which includes the wider set. Excludes `auto`.
 */
export const DEFAULT_CHAT_PROVIDERS: PickerProvider[] = [
  'claude', 'codex', 'antigravity', 'copilot',
];

/**
 * Sidechat provider order: every session provider with a working conversation
 * runtime, including OpenCode, Grok, Cursor and local models.
 */
export const SIDE_CHAT_MENU_PROVIDERS: PickerProvider[] = [
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

/** Menu names come from the one name module; the record keeps every picker provider covered. */
export const PROVIDER_MENU_LABELS: Record<PickerProvider, string> = {
  claude: providerName('claude'),
  codex: providerName('codex'),
  gemini: providerName('gemini'),
  antigravity: providerName('antigravity'),
  copilot: providerName('copilot'),
  cursor: providerName('cursor'),
  grok: providerName('grok'),
  opencode: providerName('opencode'),
  'local-model': providerName('local-model'),
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
