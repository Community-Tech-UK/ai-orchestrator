import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_PROVIDERS,
  DEFAULT_INSTANCE_PROVIDERS,
  PROVIDER_MENU_COLORS,
  PROVIDER_MENU_LABELS,
} from './provider-menu.constants';

describe('provider menu constants', () => {
  it('keeps the chat provider order fixed without auto or cursor', () => {
    expect(DEFAULT_CHAT_PROVIDERS).toEqual(['claude', 'codex', 'antigravity', 'copilot']);
  });

  it('keeps the wider instance provider order including cursor', () => {
    expect(DEFAULT_INSTANCE_PROVIDERS).toEqual(['claude', 'codex', 'antigravity', 'copilot', 'cursor']);
  });

  it('keeps labels and theme-safe colors available for every picker provider', () => {
    expect(PROVIDER_MENU_LABELS).toMatchObject({
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      antigravity: 'Antigravity',
      copilot: 'Copilot',
      cursor: 'Cursor',
    });
    expect(PROVIDER_MENU_COLORS.cursor).toBe('var(--text-primary)');
  });
});
