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
/**
 * S2.2 — lifecycle stage for a setting.
 *
 * Names what a setting IS rather than only where it renders. The honesty rule
 * that motivates it: an experimental toggle presented identically to a stable
 * one invites people to switch it on and be surprised. `deprecated` and
 * `removed` exist so a key can stop being offered without vanishing from the
 * record, which is what makes a rename traceable later.
 *
 * Absent means `stable`. That default is deliberate — the overwhelming majority
 * of settings are stable, and requiring every one to declare it would produce a
 * field nobody reads, which is how metadata rots.
 */
export type SettingStage =
  | 'under-development'
  | 'experimental'
  | 'stable'
  | 'deprecated'
  | 'removed';

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
  /** S2.2 lifecycle stage. Absent means `stable`. */
  stage?: SettingStage;
  /**
   * S2.2 — the change does not take effect until the app restarts. Surfaced so
   * a user is not left wondering why a toggle appeared to do nothing.
   */
  requiresRestart?: boolean;
  /**
   * S2.2 — holds or points at a credential. Used to keep values out of
   * exports, logs and screenshots; never to imply the value is encrypted.
   */
  sensitive?: boolean;
  /**
   * S2.2 — this setting only does anything when another is enabled. Named so a
   * UI can say "requires X" instead of leaving a dead-looking control.
   */
  dependsOn?: keyof AppSettings;
  /** S2.2 — extra search terms, for a settings search that matches intent. */
  keywords?: readonly string[];
  /**
   * Omit from GENERIC, category-driven listings (the Advanced tab renders whole
   * categories). It does not mean "not user-visible": a tab that owns a setting
   * and selects it by explicit key still renders it. Without this distinction
   * every `computerUse*` key appeared twice — once via the `mcp` category on
   * Advanced, once on the dedicated Computer Use tab.
   */
  hidden?: boolean;
}
