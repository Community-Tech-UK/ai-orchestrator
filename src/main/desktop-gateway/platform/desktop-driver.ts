import {
  desktopCapturer,
  systemPreferences,
  type DesktopCapturerSource,
} from 'electron';
import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopAppDescriptor,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopDriverHealth,
  DesktopHotkeyRequest,
  DesktopScrollRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopTypeTextRequest,
} from '../../../shared/types/desktop-gateway.types';

export interface DesktopDriver {
  health(): Promise<DesktopDriverHealth>;
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
    return new ElectronDesktopDriver();
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

export class ElectronDesktopDriver implements DesktopDriver {
  async health(): Promise<DesktopDriverHealth> {
    const screenStatus = screenCaptureState();
    return {
      platform: process.platform,
      supported: process.platform === 'darwin',
      screenCapture: screenStatus,
      accessibility: 'unavailable',
      input: 'unavailable',
      setupActions: [
        ...(screenStatus === 'missing_permission'
          ? ['Grant Screen Recording permission to AI Orchestrator in macOS System Settings.']
          : []),
        'Install the signed desktop helper before accessibility snapshots or input actions are enabled.',
      ],
    };
  }

  async listApps(): Promise<DesktopAppDescriptor[]> {
    const sources = await getDesktopSources({ width: 1, height: 1 });
    return sources
      .filter((source) => source.id)
      .map((source) => ({
        appId: appIdForSource(source),
        displayName: normalizeSourceName(source.name),
        platform: process.platform,
        windowId: source.id,
        visibleWindowCount: 1,
      }));
  }

  async screenshot(request: DesktopScreenshotRequest): Promise<DesktopScreenshotResult> {
    const width = Math.max(1, Math.min(4096, Math.round((request.region?.width ?? 1280) * (request.scale ?? 1))));
    const height = Math.max(1, Math.min(4096, Math.round((request.region?.height ?? 800) * (request.scale ?? 1))));
    const sources = await getDesktopSources({ width, height });
    const source = sources.find((candidate) => matchesSource(candidate, request));
    if (!source) {
      throw new Error('computer_use_target_not_found');
    }
    const image = source.thumbnail;
    const size = image.getSize();
    return {
      appId: appIdForSource(source),
      windowId: source.id,
      data: image.toPNG().toString('base64'),
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      capturedAt: Date.now(),
    };
  }

  async accessibilitySnapshot(
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopAccessibilitySnapshotResult> {
    throw new Error(`computer_use_missing_accessibility:${request.appId ?? request.windowId ?? 'unknown'}`);
  }

  async click(): Promise<DesktopActionResult> {
    throw new Error('computer_use_missing_accessibility');
  }

  async typeText(): Promise<DesktopActionResult> {
    throw new Error('computer_use_missing_accessibility');
  }

  async hotkey(): Promise<DesktopActionResult> {
    throw new Error('computer_use_missing_accessibility');
  }

  async scroll(): Promise<DesktopActionResult> {
    throw new Error('computer_use_missing_accessibility');
  }

  async drag(): Promise<DesktopActionResult> {
    throw new Error('computer_use_missing_accessibility');
  }
}

async function getDesktopSources(
  thumbnailSize: { width: number; height: number },
): Promise<DesktopCapturerSource[]> {
  if (!desktopCapturer?.getSources) {
    return [];
  }
  return desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
}

function matchesSource(source: DesktopCapturerSource, request: DesktopScreenshotRequest): boolean {
  return request.appId === appIdForSource(source)
    || request.windowId === source.id
    || request.displayId === source.id;
}

function appIdForSource(source: DesktopCapturerSource): string {
  return `darwin-window:${encodeURIComponent(source.id)}`;
}

function normalizeSourceName(name: string): string {
  return name.trim().slice(0, 200) || 'Untitled window';
}

function screenCaptureState(): DesktopDriverHealth['screenCapture'] {
  if (process.platform !== 'darwin') {
    return 'unsupported';
  }
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'granted') {
      return 'available';
    }
    if (status === 'denied' || status === 'restricted' || status === 'not-determined') {
      return 'missing_permission';
    }
  } catch {
    return 'available';
  }
  return 'available';
}
