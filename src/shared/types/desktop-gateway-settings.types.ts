/**
 * How much of the desktop the Computer Use tools may drive without a human.
 *
 * - `guarded`      — the original hard-coded denials: no terminals, no provider
 *                    apps, no System Settings, no password managers, no Enter or
 *                    Space keypress, no sensitive control, no secret-like text.
 * - `trusted`      — everything above is permitted except driving Harness's own
 *                    UI and genuinely destructive hotkeys. This is the default.
 * - `unrestricted` — no built-in denials at all, including Harness's own window.
 *
 * The Harness window is held back at `trusted` for a specific reason: it renders
 * the Computer Use grant approvals and browser approval prompts. An agent that
 * can click those approves its own escalations, which does not add autonomy — it
 * makes every grant record report a human decision that never happened. To stop
 * being asked, set `computerUseRequireApprovalForInput` to false, which removes
 * the gate honestly and leaves the audit log saying so.
 */
export type ComputerUseAutonomyLevel = 'guarded' | 'trusted' | 'unrestricted';

/** Tuple, not a plain array: `z.enum()` needs the literal members preserved. */
export const COMPUTER_USE_AUTONOMY_LEVELS = [
  'guarded',
  'trusted',
  'unrestricted',
] as const satisfies readonly ComputerUseAutonomyLevel[];

export interface DesktopComputerUseSettings {
  computerUseEnabled: boolean;
  computerUseAllowedAppsJson: string;
  computerUseDeniedAppsJson: string;
  computerUseRequireApprovalForInput: boolean;
  computerUseStoreScreenshotsForEscalations: boolean;
  computerUseAutonomyLevel: ComputerUseAutonomyLevel;
}

export const DEFAULT_DESKTOP_COMPUTER_USE_SETTINGS: DesktopComputerUseSettings = {
  computerUseEnabled: false,
  computerUseAllowedAppsJson: '[]',
  computerUseDeniedAppsJson: '[]',
  computerUseRequireApprovalForInput: true,
  computerUseStoreScreenshotsForEscalations: false,
  computerUseAutonomyLevel: 'trusted',
};
