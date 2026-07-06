/**
 * Settings-tab help registry.
 *
 * Maps every Settings tab to its Help & tips content. Typed as a total
 * `Record` so adding a new tab without help content is a compile error.
 * Tabs that embed a Control Center page (Models, MCP, Hooks, Worktrees,
 * Snapshots, Archive, Remote Config) reuse that page's entry so the copy
 * stays identical on both surfaces.
 */

import type { HelpEntry } from '../../../shared/help/help-content.types';
import { CONTROL_SURFACE_HELP } from '../../../shared/help/control-surface-help';
import type { SettingsTab } from '../settings-navigation';
import {
  ADVANCED_TAB_HELP,
  AUXILIARY_MODELS_TAB_HELP,
  DISPLAY_TAB_HELP,
  ECOSYSTEM_TAB_HELP,
  GENERAL_TAB_HELP,
  KEYBOARD_TAB_HELP,
  MEMORY_TAB_HELP,
  ORCHESTRATION_TAB_HELP,
  PERMISSIONS_TAB_HELP,
  REVIEW_TAB_HELP,
} from './settings-help-core';
import {
  CLI_HEALTH_TAB_HELP,
  CONNECTIONS_TAB_HELP,
  DOCTOR_TAB_HELP,
  MOBILE_TAB_HELP,
  NETWORK_TAB_HELP,
  PROVIDER_QUOTA_TAB_HELP,
  REMOTE_NODES_TAB_HELP,
  RTK_SAVINGS_TAB_HELP,
  VOICE_TAB_HELP,
} from './settings-help-system';

export const SETTINGS_TAB_HELP: Record<SettingsTab, HelpEntry> = {
  'general': GENERAL_TAB_HELP,
  'orchestration': ORCHESTRATION_TAB_HELP,
  'connections': CONNECTIONS_TAB_HELP,
  'network': NETWORK_TAB_HELP,
  'voice': VOICE_TAB_HELP,
  'memory': MEMORY_TAB_HELP,
  'display': DISPLAY_TAB_HELP,
  'ecosystem': ECOSYSTEM_TAB_HELP,
  'permissions': PERMISSIONS_TAB_HELP,
  'review': REVIEW_TAB_HELP,
  'advanced': ADVANCED_TAB_HELP,
  'keyboard': KEYBOARD_TAB_HELP,
  'remote-nodes': REMOTE_NODES_TAB_HELP,
  'mobile': MOBILE_TAB_HELP,
  'doctor': DOCTOR_TAB_HELP,
  'cli-health': CLI_HEALTH_TAB_HELP,
  'provider-quota': PROVIDER_QUOTA_TAB_HELP,
  'rtk-savings': RTK_SAVINGS_TAB_HELP,
  'auxiliary-models': AUXILIARY_MODELS_TAB_HELP,
  // Embedded Control Center pages share their surface entry.
  'models': CONTROL_SURFACE_HELP['models'],
  'mcp': CONTROL_SURFACE_HELP['mcp'],
  'hooks': CONTROL_SURFACE_HELP['hooks'],
  'worktrees': CONTROL_SURFACE_HELP['worktrees'],
  'snapshots': CONTROL_SURFACE_HELP['snapshots'],
  'archive': CONTROL_SURFACE_HELP['archive'],
  'remote-config': CONTROL_SURFACE_HELP['remote-config'],
};
