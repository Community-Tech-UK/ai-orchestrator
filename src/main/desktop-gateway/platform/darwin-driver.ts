import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopActionResult,
  DesktopAppDescriptor,
  DesktopCapabilityState,
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
import { desktopCapturer, systemPreferences } from 'electron';
import type { DesktopDriver } from './desktop-driver';
import { BundledDarwinHelperClient } from './darwin-helper-client';
import type { DesktopHelperClient } from './desktop-helper-protocol';

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
  /**
   * Electron `systemPreferences.getMediaAccessStatus('screen')` seam. Screen
   * Recording health must come from the process that performs the capture
   * (Electron), never from the helper's own preflight.
   */
  getScreenAccessStatus?: () => string;
  /**
   * Minimal real `desktopCapturer.getSources()` call used to register Harness
   * in macOS's Screen Recording list on a user-initiated request. All returned
   * sources are discarded immediately.
   */
  requestScreenAccess?: () => Promise<void>;
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
  private readonly getScreenAccessStatus: () => string;
  private readonly requestScreenAccess: () => Promise<void>;
  private readonly now: () => number;
  /** One in-flight native request per permission so concurrent clicks never stack prompts. */
  private readonly inflightPermissionRequests
    = new Map<DesktopSystemPermission, Promise<DesktopPermissionRequestResult>>();

  constructor(deps: DarwinDesktopDriverDeps = {}) {
    this.helper = deps.helper ?? new BundledDarwinHelperClient();
    this.captureScreenshot = deps.captureScreenshot ?? defaultCaptureBackend;
    this.getScreenAccessStatus = deps.getScreenAccessStatus ?? defaultScreenAccessStatus;
    this.requestScreenAccess = deps.requestScreenAccess ?? defaultScreenAccessRequest;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Composed permission health. Screen Recording comes from Electron (the
   * process that captures); Accessibility and input come from the bundled
   * Swift helper (the process that inspects and synthesizes input). The
   * helper's legacy `screenRecording` field is intentionally ignored.
   */
  async health(): Promise<DesktopDriverHealth> {
    const screenCapture = mapScreenAccessStatus(this.getScreenAccessStatus());
    const helperHealth = await this.helper.health();
    if (helperHealth.mode === 'unavailable') {
      return {
        platform: 'darwin',
        supported: true,
        screenCapture,
        accessibility: 'unavailable',
        input: 'unavailable',
        setupActions: composeSetupActions(screenCapture, 'unavailable', helperHealth.setupActions),
      };
    }
    const accessibility: DesktopCapabilityState = helperHealth.accessibility
      ? 'available'
      : 'missing_permission';
    const input: DesktopCapabilityState = helperHealth.accessibility && helperHealth.input
      ? 'available'
      : 'missing_permission';
    return {
      platform: 'darwin',
      supported: true,
      screenCapture,
      accessibility,
      input,
      setupActions: composeSetupActions(screenCapture, accessibility, []),
    };
  }

  async requestSystemPermission(
    permission: DesktopSystemPermission,
  ): Promise<DesktopPermissionRequestResult> {
    const existing = this.inflightPermissionRequests.get(permission);
    if (existing) {
      return existing;
    }
    const request = this.performPermissionRequest(permission)
      .finally(() => this.inflightPermissionRequests.delete(permission));
    this.inflightPermissionRequests.set(permission, request);
    return request;
  }

  private async performPermissionRequest(
    permission: DesktopSystemPermission,
  ): Promise<DesktopPermissionRequestResult> {
    if (permission === 'screen-recording') {
      if (mapScreenAccessStatus(this.getScreenAccessStatus()) === 'available') {
        return { permission, state: 'available', nativeRequestAttempted: false };
      }
      try {
        await this.requestScreenAccess();
      } catch {
        // The recheck below reports the truthful post-request state.
      }
      return {
        permission,
        state: mapScreenAccessStatus(this.getScreenAccessStatus()),
        nativeRequestAttempted: true,
      };
    }
    const before = await this.helper.health();
    if (before.mode === 'unavailable') {
      return { permission, state: 'unavailable', nativeRequestAttempted: false };
    }
    if (before.accessibility) {
      return { permission, state: 'available', nativeRequestAttempted: false };
    }
    try {
      await this.helper.requestAccessibility();
    } catch {
      // Prompt failure is not fatal; the recheck reports the current state.
    }
    const after = await this.helper.health();
    const state: DesktopCapabilityState = after.mode === 'unavailable'
      ? 'unavailable'
      : after.accessibility ? 'available' : 'missing_permission';
    return { permission, state, nativeRequestAttempted: true };
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

/**
 * Electron media-access status → gateway capability state.
 * `granted` is ready; `not-determined`/`denied` are user-fixable via a request
 * or System Settings; `restricted`/`unknown` (and anything unexpected) cannot
 * be fixed by the user here.
 */
export function mapScreenAccessStatus(status: string): DesktopCapabilityState {
  switch (status) {
    case 'granted':
      return 'available';
    case 'not-determined':
    case 'denied':
      return 'missing_permission';
    default:
      return 'unavailable';
  }
}

function composeSetupActions(
  screenCapture: DesktopCapabilityState,
  accessibility: DesktopCapabilityState,
  helperSetupActions: string[],
): string[] {
  const actions: string[] = [];
  if (screenCapture !== 'available') {
    actions.push(
      'Grant Screen Recording to Harness in System Settings → Privacy & Security → Screen Recording.',
    );
  }
  if (accessibility === 'unavailable') {
    actions.push(...helperSetupActions);
  } else if (accessibility !== 'available') {
    actions.push(
      'Grant Accessibility to Harness in System Settings → Privacy & Security → Accessibility.',
    );
  }
  return actions;
}

function defaultScreenAccessStatus(): string {
  return systemPreferences?.getMediaAccessStatus?.('screen') ?? 'unknown';
}

async function defaultScreenAccessRequest(): Promise<void> {
  if (!desktopCapturer?.getSources) {
    return;
  }
  // Exercise the real protected API so macOS registers Harness under Screen &
  // System Audio Recording; discard every returned source immediately.
  await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });
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
