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
  hidden?: boolean;
}
