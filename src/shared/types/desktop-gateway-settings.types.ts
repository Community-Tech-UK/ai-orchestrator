export interface DesktopComputerUseSettings {
  computerUseEnabled: boolean;
  computerUseAllowedAppsJson: string;
  computerUseDeniedAppsJson: string;
  computerUseRequireApprovalForInput: boolean;
  computerUseStoreScreenshotsForEscalations: boolean;
}

export const DEFAULT_DESKTOP_COMPUTER_USE_SETTINGS: DesktopComputerUseSettings = {
  computerUseEnabled: false,
  computerUseAllowedAppsJson: '[]',
  computerUseDeniedAppsJson: '[]',
  computerUseRequireApprovalForInput: true,
  computerUseStoreScreenshotsForEscalations: false,
};
