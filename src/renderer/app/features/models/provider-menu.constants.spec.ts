import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_PROVIDERS,
  SIDECAT_CHAT_PROVIDERS,
  DEFAULT_INSTANCE_PROVIDERS,
  PROVIDER_MENU_COLORS,
  PROVIDER_MENU_LABELS,
} from './provider-menu.constants';

describe('provider menu constants', () => {
  it('keeps the main chat provider order narrow without auto', () => {
    expect(DEFAULT_CHAT_PROVIDERS).toEqual(['claude', 'codex', 'antigravity', 'copilot']);
    expect(DEFAULT_CHAT_PROVIDERS).not.toContain('auto');
  });

  it('includes every session provider with a working conversation runtime for sidechats', () => {
    expect(SIDECAT_CHAT_PROVIDERS).toEqual([
      'claude', 'codex', 'antigravity', 'copilot', 'grok', 'opencode', 'cursor', 'local-model',
    ]);
    expect(SIDECAT_CHAT_PROVIDERS).not.toContain('auto');
  });

  it('keeps the wider instance provider order including cursor and local models', () => {
    expect(DEFAULT_INSTANCE_PROVIDERS).toEqual([
      'claude',
      'codex',
      'antigravity',
      'copilot',
      'cursor',
      'grok',
      'opencode',
      'local-model',
    ]);
  });

  it('keeps labels and theme-safe colors available for every picker provider', () => {
    expect(PROVIDER_MENU_LABELS).toMatchObject({
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      antigravity: 'Antigravity',
      copilot: 'Copilot',
      cursor: 'Cursor',
      grok: 'Grok',
      opencode: 'OpenCode',
      'local-model': 'Local Models',
    });
    expect(PROVIDER_MENU_COLORS.cursor).toBe('var(--text-primary)');
    expect(PROVIDER_MENU_COLORS.grok).toBe('#1da1f2');
    expect(PROVIDER_MENU_COLORS.opencode).toBe('var(--text-secondary)');
    expect(PROVIDER_MENU_COLORS['local-model']).toBe('#14b8a6');
  });
});
