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
import { desktopCapturer } from 'electron';
import type { DesktopDriver } from './desktop-driver';
import { BundledDarwinHelperClient } from './darwin-helper-client';
import type { DesktopHelperClient, DesktopHelperHealth } from './desktop-helper-protocol';

/**
 * Raw screenshot bytes for a target, resolved by the injected capture backend
 * (Electron `desktopCapturer` in production, a fake in tests).
 */
export interface DesktopCaptureResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  windowId?: string;
}

export type DesktopCaptureBackend = (
  request: DesktopScreenshotRequest,
  hints: { displayName?: string; windowId?: string },
) => Promise<DesktopCaptureResult | null>;

export interface DarwinDesktopDriverDeps {
  helper?: DesktopHelperClient;
  captureScreenshot?: DesktopCaptureBackend;
  now?: () => number;
}

/**
 * macOS desktop driver.
 *
 * Screenshots use the injected capture backend (Electron `desktopCapturer` by
 * default — no extra TCC beyond Screen Recording). Accessibility snapshots and
 * all input actions are delegated to a {@link DesktopHelperClient} so the
 * OS-automation mechanics sit behind a narrow, swappable boundary. The policy,
 * grant, lock, and audit layers stay in the service; this class only performs
 * mechanics for an already-authorized target.
 */
export class DarwinDesktopDriver implements DesktopDriver {
  private readonly helper: DesktopHelperClient;
  private readonly captureScreenshot: DesktopCaptureBackend;
  private readonly now: () => number;

  constructor(deps: DarwinDesktopDriverDeps = {}) {
    this.helper = deps.helper ?? new BundledDarwinHelperClient();
    this.captureScreenshot = deps.captureScreenshot ?? defaultCaptureBackend;
    this.now = deps.now ?? Date.now;
  }

  async health(): Promise<DesktopDriverHealth> {
    const helperHealth = await this.helper.health();
    if (helperHealth.mode === 'unavailable') {
      return {
        platform: 'darwin',
        supported: true,
        screenCapture: 'unavailable',
        accessibility: 'unavailable',
        input: 'unavailable',
        setupActions: helperHealth.setupActions,
      };
    }
    return {
      platform: 'darwin',
      supported: true,
      screenCapture: helperHealth.screenRecording ? 'available' : 'missing_permission',
      accessibility: helperHealth.accessibility ? 'available' : 'missing_permission',
      input: inputState(helperHealth),
      setupActions: helperHealth.setupActions,
    };
  }

  async listApps(): Promise<DesktopAppDescriptor[]> {
    return this.helper.listApps();
  }

  async screenshot(request: DesktopScreenshotRequest): Promise<DesktopScreenshotResult> {
    const hints = await this.resolveCaptureHints(request.appId);
    const captured = await this.captureScreenshot(request, hints);
    if (!captured) {
      throw new Error('computer_use_target_not_found');
    }
    return {
      appId: request.appId ?? request.windowId ?? hints.displayName ?? 'darwin-screen',
      ...(captured.windowId ? { windowId: captured.windowId } : {}),
      data: captured.data,
      mimeType: captured.mimeType,
      width: captured.width,
      height: captured.height,
      capturedAt: this.now(),
    };
  }

  async accessibilitySnapshot(
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopAccessibilitySnapshotResult> {
    return this.helper.accessibilitySnapshot(request);
  }

  async click(request: DesktopClickRequest): Promise<DesktopActionResult> {
    await this.helper.click(request);
    return this.ok(request.appId);
  }

  async typeText(request: DesktopTypeTextRequest): Promise<DesktopActionResult> {
    await this.helper.typeText(request);
    return this.ok(request.appId);
  }

  async hotkey(request: DesktopHotkeyRequest): Promise<DesktopActionResult> {
    await this.helper.hotkey(request);
    return this.ok(request.appId);
  }

  async scroll(request: DesktopScrollRequest): Promise<DesktopActionResult> {
    await this.helper.scroll(request);
    return this.ok(request.appId);
  }

  async drag(request: DesktopDragRequest): Promise<DesktopActionResult> {
    await this.helper.drag(request);
    return this.ok(request.appId);
  }

  private ok(appId: string): DesktopActionResult {
    return { status: 'ok', appId, completedAt: this.now() };
  }

  private async resolveCaptureHints(
    appId: string | undefined,
  ): Promise<{ displayName?: string; windowId?: string }> {
    if (!appId) {
      return {};
    }
    try {
      const apps = await this.helper.listApps();
      const match = apps.find((app) => app.appId === appId || app.bundleId === appId);
      return {
        ...(match?.displayName ? { displayName: match.displayName } : {}),
        ...(match?.windowId ? { windowId: match.windowId } : {}),
      };
    } catch {
      return {};
    }
  }
}

function inputState(health: DesktopHelperHealth): DesktopDriverHealth['input'] {
  if (health.input) {
    return 'available';
  }
  return health.accessibility ? 'missing_permission' : 'unavailable';
}

async function defaultCaptureBackend(
  request: DesktopScreenshotRequest,
  hints: { displayName?: string; windowId?: string },
): Promise<DesktopCaptureResult | null> {
  if (!desktopCapturer?.getSources) {
    return null;
  }
  const scale = request.scale ?? 1;
  const width = Math.max(1, Math.min(4096, Math.round((request.region?.width ?? 1280) * scale)));
  const height = Math.max(1, Math.min(4096, Math.round((request.region?.height ?? 800) * scale)));
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const source = selectDesktopCaptureSource(sources, {
    windowId: request.windowId ?? hints.windowId,
    displayName: hints.displayName,
  });
  if (!source) {
    return null;
  }
  const image = source.thumbnail;
  const size = image.getSize();
  return {
    data: image.toPNG().toString('base64'),
    mimeType: 'image/png',
    width: size.width,
    height: size.height,
    windowId: source.id,
  };
}

export function selectDesktopCaptureSource<T extends { id: string; name: string }>(
  sources: T[],
  target: { windowId?: string; displayName?: string },
): T | null {
  const requestedWindowId = target.windowId;
  if (requestedWindowId) {
    return sources.find((candidate) =>
      desktopSourceMatchesWindowId(candidate.id, requestedWindowId)) ?? null;
  }
  if (!target.displayName) {
    return null;
  }
  const expectedName = target.displayName.toLocaleLowerCase();
  return sources.find((candidate) => {
    const name = candidate.name.toLocaleLowerCase();
    return name === expectedName
      || name.startsWith(`${expectedName} `)
      || name.startsWith(`${expectedName} -`);
  }) ?? null;
}

function desktopSourceMatchesWindowId(sourceId: string, requestedWindowId: string): boolean {
  if (sourceId === requestedWindowId) {
    return true;
  }
  if (!/^\d+$/u.test(requestedWindowId)) {
    return false;
  }
  const electronWindowId = /^window:(\d+):\d+$/u.exec(sourceId);
  return electronWindowId?.[1] === requestedWindowId;
}
