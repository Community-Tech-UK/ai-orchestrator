import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopAppDescriptor,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopDriverHealth,
  DesktopHotkeyRequest,
  DesktopPermissionRequestResult,
  DesktopScrollRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopSystemPermission,
  DesktopTypeTextRequest,
} from '../../../shared/types/desktop-gateway.types';
import { DarwinDesktopDriver } from './darwin-driver';

export interface DesktopDriver {
  health(): Promise<DesktopDriverHealth>;
  /**
   * Perform the real user-initiated native permission request for the given
   * permission and re-read the resulting capability state. Never invoked
   * merely because the app starts; callers gate on explicit operator action.
   */
  requestSystemPermission(
    permission: DesktopSystemPermission,
  ): Promise<DesktopPermissionRequestResult>;
  listApps(): Promise<DesktopAppDescriptor[]>;
  screenshot(request: DesktopScreenshotRequest): Promise<DesktopScreenshotResult>;
  accessibilitySnapshot(
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopAccessibilitySnapshotResult>;
  click(request: DesktopClickRequest): Promise<DesktopActionResult>;
  typeText(request: DesktopTypeTextRequest): Promise<DesktopActionResult>;
  hotkey(request: DesktopHotkeyRequest): Promise<DesktopActionResult>;
  scroll(request: DesktopScrollRequest): Promise<DesktopActionResult>;
  drag(request: DesktopDragRequest): Promise<DesktopActionResult>;
}

export function createDefaultDesktopDriver(): DesktopDriver {
  if (process.platform === 'darwin') {
    return new DarwinDesktopDriver();
  }
  return new UnsupportedDesktopDriver(process.platform);
}

export class UnsupportedDesktopDriver implements DesktopDriver {
  constructor(private readonly platform: string) {}

  async health(): Promise<DesktopDriverHealth> {
    return {
      platform: this.platform,
      supported: false,
      screenCapture: 'unsupported',
      accessibility: 'unsupported',
      input: 'unsupported',
      setupActions: ['Desktop Computer Use is currently supported only on local macOS.'],
    };
  }

  /**
   * Typed unsupported result: no native request runs and no System Settings
   * URL is ever opened on a non-macOS platform.
   */
  async requestSystemPermission(
    permission: DesktopSystemPermission,
  ): Promise<DesktopPermissionRequestResult> {
    return {
      permission,
      state: 'unsupported',
      nativeRequestAttempted: false,
    };
  }

  async listApps(): Promise<DesktopAppDescriptor[]> {
    return [];
  }

  async screenshot(): Promise<DesktopScreenshotResult> {
    throw new Error('computer_use_unavailable_platform');
  }

  async accessibilitySnapshot(): Promise<DesktopAccessibilitySnapshotResult> {
    throw new Error('computer_use_missing_accessibility');
  }

  async click(): Promise<DesktopActionResult> {
    throw new Error('computer_use_unavailable_platform');
  }

  async typeText(): Promise<DesktopActionResult> {
    throw new Error('computer_use_unavailable_platform');
  }

  async hotkey(): Promise<DesktopActionResult> {
    throw new Error('computer_use_unavailable_platform');
  }

  async scroll(): Promise<DesktopActionResult> {
    throw new Error('computer_use_unavailable_platform');
  }

  async drag(): Promise<DesktopActionResult> {
    throw new Error('computer_use_unavailable_platform');
  }
}
