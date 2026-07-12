import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type {
  DesktopAccessibilitySnapshotRequest,
  DesktopAccessibilitySnapshotResult,
  DesktopAppDescriptor,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopHotkeyRequest,
  DesktopScrollRequest,
  DesktopTypeTextRequest,
} from '../../../shared/types/desktop-gateway.types';
import {
  DESKTOP_HELPER_MAX_LINE_BYTES,
  DESKTOP_HELPER_PROTOCOL_VERSION,
  DesktopHelperProtocolError,
  DesktopHelperResponseError,
  parseDesktopHelperResponse,
  serializeDesktopHelperRequest,
  type DesktopHelperClient,
  type DesktopHelperCommandName,
  type DesktopHelperHealth,
} from './desktop-helper-protocol';

const DEFAULT_HELPER_TIMEOUT_MS = 15_000;

export type DesktopHelperRunner = (
  helperPath: string,
  input: string,
) => Promise<{ stdout: string; stderr: string }>;

export interface DesktopHelperPathContext {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export interface BundledDarwinHelperClientDeps {
  helperPath?: string;
  pathContext?: DesktopHelperPathContext;
  pathExists?: (helperPath: string) => boolean | Promise<boolean>;
  run?: DesktopHelperRunner;
  createRequestId?: () => string;
}

interface RawHelperHealth {
  version?: unknown;
  screenRecording?: unknown;
  accessibility?: unknown;
  input?: unknown;
}

interface RawHelperWindow {
  id?: unknown;
  title?: unknown;
}

interface RawHelperApp {
  name?: unknown;
  bundleId?: unknown;
  pid?: unknown;
  windows?: unknown;
}

interface RawListAppsResult {
  apps?: unknown;
}

export function resolveDesktopHelperPath(context: DesktopHelperPathContext): string {
  return context.isPackaged
    ? join(context.resourcesPath, 'desktop-helper', 'desktop-helper')
    : join(context.appPath, 'dist', 'desktop-helper', 'desktop-helper');
}

export class BundledDarwinHelperClient implements DesktopHelperClient {
  private readonly helperPath: string;
  private readonly pathExists: (helperPath: string) => boolean | Promise<boolean>;
  private readonly run: DesktopHelperRunner;
  private readonly createRequestId: () => string;

  constructor(deps: BundledDarwinHelperClientDeps = {}) {
    this.helperPath = deps.helperPath
      ?? resolveDesktopHelperPath(deps.pathContext ?? defaultPathContext());
    this.pathExists = deps.pathExists ?? defaultPathExists;
    this.run = deps.run ?? runDesktopHelper;
    this.createRequestId = deps.createRequestId ?? randomUUID;
  }

  async health(): Promise<DesktopHelperHealth> {
    if (!await this.pathExists(this.helperPath)) {
      return unavailableHealth(
        'helper_missing',
        'The bundled macOS Desktop Computer Use helper is missing. Reinstall Harness.',
      );
    }
    try {
      const raw = await this.request<RawHelperHealth>('health', {});
      if (raw.version !== DESKTOP_HELPER_PROTOCOL_VERSION) {
        return unavailableHealth(
          'version_mismatch',
          'The bundled macOS Desktop Computer Use helper version does not match Harness.',
        );
      }
      if (typeof raw.screenRecording !== 'boolean'
        || typeof raw.accessibility !== 'boolean'
        || typeof raw.input !== 'boolean') {
        return unavailableHealth(
          'helper_failed',
          'The bundled macOS Desktop Computer Use helper returned an invalid health response.',
        );
      }
      return {
        version: raw.version,
        screenRecording: raw.screenRecording,
        accessibility: raw.accessibility,
        input: raw.input,
        setupActions: permissionSetupActions(raw.screenRecording, raw.accessibility),
        mode: 'bundled',
        degraded: false,
      };
    } catch (error) {
      if ((error instanceof DesktopHelperProtocolError
        && error.code === 'helper_version_mismatch')
        || (error instanceof Error
          && error.message === 'computer_use_helper_version_mismatch')) {
        return unavailableHealth(
          'version_mismatch',
          'The bundled macOS Desktop Computer Use helper version does not match Harness.',
        );
      }
      return unavailableHealth(
        'helper_failed',
        'The bundled macOS Desktop Computer Use helper could not be started.',
      );
    }
  }

  /**
   * Ask the helper to show the macOS Accessibility prompt and report the
   * current trust state. `false` is a valid post-prompt state, never an error.
   */
  async requestAccessibility(): Promise<boolean> {
    const raw = await this.request<{ trusted?: unknown }>('requestAccessibility', {});
    if (!raw || typeof raw !== 'object' || typeof raw.trusted !== 'boolean') {
      throw new Error('computer_use_driver_failed');
    }
    return raw.trusted;
  }

  async listApps(): Promise<DesktopAppDescriptor[]> {
    const raw = await this.request<RawListAppsResult>('listApps', {});
    if (!Array.isArray(raw.apps)) {
      throw new Error('computer_use_driver_failed');
    }
    return raw.apps
      .slice(0, 512)
      .map((entry) => mapApp(entry as RawHelperApp))
      .filter((entry): entry is DesktopAppDescriptor => entry !== null);
  }

  async accessibilitySnapshot(
    request: DesktopAccessibilitySnapshotRequest,
  ): Promise<DesktopAccessibilitySnapshotResult> {
    const result = await this.request<DesktopAccessibilitySnapshotResult>(
      'accessibilitySnapshot',
      { ...request },
    );
    if (!result || typeof result !== 'object' || !Array.isArray(result.nodes)) {
      throw new Error('computer_use_driver_failed');
    }
    return result;
  }

  async click(request: DesktopClickRequest): Promise<void> {
    await this.request('click', { ...request });
  }

  async typeText(request: DesktopTypeTextRequest): Promise<void> {
    await this.request('typeText', { ...request });
  }

  async hotkey(request: DesktopHotkeyRequest): Promise<void> {
    await this.request('hotkey', { ...request });
  }

  async scroll(request: DesktopScrollRequest): Promise<void> {
    await this.request('scroll', { ...request });
  }

  async drag(request: DesktopDragRequest): Promise<void> {
    await this.request('drag', { ...request });
  }

  private async request<T = unknown>(
    command: DesktopHelperCommandName,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!await this.pathExists(this.helperPath)) {
      throw new Error('computer_use_helper_missing');
    }
    const id = this.createRequestId();
    const input = serializeDesktopHelperRequest(id, command, payload);
    try {
      const { stdout } = await this.run(this.helperPath, input);
      return parseDesktopHelperResponse<T>(stdout, id);
    } catch (error) {
      throw new Error(mapHelperError(error));
    }
  }
}

function defaultPathContext(): DesktopHelperPathContext {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
}

async function defaultPathExists(helperPath: string): Promise<boolean> {
  try {
    await access(helperPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runDesktopHelper(
  helperPath: string,
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('desktop_helper_timeout')));
    }, DEFAULT_HELPER_TIMEOUT_MS);
    child.on('error', () => {
      finish(() => reject(new Error('desktop_helper_start_failed')));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > DESKTOP_HELPER_MAX_LINE_BYTES) {
        child.kill();
        finish(() => reject(new Error('desktop_helper_output_too_large')));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr, 'utf8') < 4096) {
        stderr += chunk;
      }
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error('desktop_helper_failed'));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    child.stdin.end(input);
  });
}

function unavailableHealth(
  issue: DesktopHelperHealth['issue'],
  setupAction: string,
): DesktopHelperHealth {
  return {
    version: DESKTOP_HELPER_PROTOCOL_VERSION,
    screenRecording: false,
    accessibility: false,
    input: false,
    setupActions: [setupAction],
    mode: 'unavailable',
    degraded: true,
    issue,
  };
}

function permissionSetupActions(
  screenRecording: boolean,
  accessibility: boolean,
): string[] {
  const actions: string[] = [];
  if (!screenRecording) {
    actions.push(
      'Grant Screen Recording to Harness in System Settings → Privacy & Security → Screen Recording.',
    );
  }
  if (!accessibility) {
    actions.push(
      'Grant Accessibility to Harness in System Settings → Privacy & Security → Accessibility.',
    );
  }
  return actions;
}

function mapApp(raw: RawHelperApp): DesktopAppDescriptor | null {
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return null;
  }
  const bundleId = typeof raw.bundleId === 'string' && raw.bundleId.trim()
    ? raw.bundleId.trim()
    : undefined;
  const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0
    ? raw.pid
    : undefined;
  const windows = Array.isArray(raw.windows)
    ? raw.windows.slice(0, 256) as RawHelperWindow[]
    : [];
  const firstWindowId = windows.find((window) =>
    typeof window.id === 'number' || typeof window.id === 'string')?.id;
  return {
    appId: bundleId
      ? `darwin-app:${bundleId}`
      : `darwin-app:pid:${pid ?? raw.name}`,
    displayName: raw.name.trim(),
    platform: 'darwin',
    ...(bundleId ? { bundleId } : {}),
    ...(pid ? { pid } : {}),
    ...(firstWindowId !== undefined ? { windowId: String(firstWindowId) } : {}),
    visibleWindowCount: windows.length,
  };
}

function mapHelperError(error: unknown): string {
  if (error instanceof DesktopHelperProtocolError) {
    return error.code === 'helper_version_mismatch'
      ? 'computer_use_helper_version_mismatch'
      : 'computer_use_driver_failed';
  }
  if (error instanceof DesktopHelperResponseError) {
    switch (error.helperCode) {
      case 'accessibility_denied':
        return 'computer_use_missing_accessibility';
      case 'target_not_found':
        return 'computer_use_target_not_found';
      case 'target_not_active':
        return 'computer_use_target_not_active';
      case 'target_outside_window':
        return 'computer_use_target_outside_approved_window';
      case 'sensitive_target':
        return 'computer_use_sensitive_action_blocked';
      case 'invalid_request':
        return 'computer_use_invalid_request';
      default:
        return 'computer_use_driver_failed';
    }
  }
  return 'computer_use_driver_failed';
}
