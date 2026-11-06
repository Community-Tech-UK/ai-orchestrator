/**
 * Display-section `AppSettings` fields (transcript, cost and tip visibility).
 *
 * Split out of `settings.types.ts` (LOC ratchet split): self-contained — only
 * `settings-primitives.types` aliases — while `AppSettings` extends it, the
 * same companion-interface pattern as `DesktopComputerUseSettings` and
 * `ObservationSettings`.
 */

import type { DisplayDensity, SidebarStyle } from './settings-primitives.types';

export interface DisplaySettings {
  fontSize: number; // 12-20
  displayDensity: DisplayDensity;
  sidebarStyle: SidebarStyle;
  contextWarningThreshold: number; // 0-100 percentage
  showToolMessages: boolean;
  showThinking: boolean; // Display AI thinking process in collapsible panels
  thinkingDefaultExpanded: boolean; // Show thinking panels expanded instead of collapsed
  showWorkingTips: boolean; // Offer unused-feature tips during long waits.
  claudeShowTaskList: boolean; // Enable Claude task tools for new/restarted local main chats.
  showCost: boolean; // Display running cost estimates (per-instance and aggregated). Off = hide for managed setups.
}
