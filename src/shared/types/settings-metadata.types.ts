import type { AppSettings } from './settings.types';

/**
 * Settings metadata for UI rendering.
 *
 * Future settings to consider:
 * - Keyboard shortcuts customization
 * - Auto-save/restore sessions
 * - Notification preferences beyond agent completion
 * - Proxy settings
 * - Log level / debug mode
 * - Export/import settings
 * - Per-project settings overrides
 * - Default instance name template
 * - Auto-scroll behavior
 * - Message timestamp format
 * - Syntax highlighting theme for code blocks
 */
export interface SettingMetadata {
  key: keyof AppSettings;
  label: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'select' | 'directory' | 'multi-select' | 'json';
  category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review' | 'network' | 'mcp' | 'rtk';
  options?: { value: string | number; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
  /**
   * Omit from GENERIC, category-driven listings (the Advanced tab renders whole
   * categories). It does not mean "not user-visible": a tab that owns a setting
   * and selects it by explicit key still renders it. Without this distinction
   * every `computerUse*` key appeared twice — once via the `mcp` category on
   * Advanced, once on the dedicated Computer Use tab.
   */
  hidden?: boolean;
}
