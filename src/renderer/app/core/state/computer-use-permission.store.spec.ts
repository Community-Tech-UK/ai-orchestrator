import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerUsePermissionStore,
  MANUAL_SETTINGS_INSTRUCTION,
} from './computer-use-permission.store';
import { SettingsStore } from './settings.store';
import { DesktopGatewayIpcService } from '../services/ipc/desktop-gateway-ipc.service';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import type { DesktopHealthData } from '../../../../shared/types/desktop-gateway.types';

function health(overrides: Partial<DesktopHealthData> = {}): DesktopHealthData {
  return {
    platform: 'darwin',
    supported: true,
    screenCapture: 'missing_permission',
    accessibility: 'missing_permission',
    input: 'missing_permission',
    setupActions: [],
    enabled: true,
    lockAvailable: true,
    injectable: false,
    ...overrides,
  };
}

function healthResponse(data: DesktopHealthData) {
  return {
    success: true as const,
    data: { decision: 'allowed' as const, outcome: 'ok' as const, data },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ComputerUsePermissionStore', () => {
  const desktop = {
    getHealth: vi.fn(),
    requestSystemPermission: vi.fn(),
  };
  let settings: ReturnType<typeof signal<AppSettings>>;
  let initialized: ReturnType<typeof signal<boolean>>;
  let platform = 'darwin';

  function setup(options: { platform?: string; enabled?: boolean; initialized?: boolean } = {}): ComputerUsePermissionStore {
    platform = options.platform ?? 'darwin';
    settings = signal<AppSettings>({
      ...DEFAULT_SETTINGS,
      computerUseEnabled: options.enabled ?? true,
    });
    initialized = signal(options.initialized ?? true);

    TestBed.configureTestingModule({
      providers: [
        ComputerUsePermissionStore,
        { provide: SettingsStore, useValue: { settings, isInitialized: initialized } },
        { provide: DesktopGatewayIpcService, useValue: desktop },
        { provide: ElectronIpcService, useValue: { get platform() { return platform; } } },
      ],
    });
    const store = TestBed.inject(ComputerUsePermissionStore);
    TestBed.tick();
    return store;
  }

  function setEnabled(enabled: boolean): void {
    settings.update((current) => ({ ...current, computerUseEnabled: enabled }));
    TestBed.tick();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    desktop.getHealth.mockResolvedValue(healthResponse(health()));
    desktop.requestSystemPermission.mockResolvedValue({
      success: true,
      data: {
        decision: 'allowed',
        outcome: 'ok',
        data: {
          permission: 'screen-recording',
          state: 'missing_permission',
          nativeRequestAttempted: true,
          settingsOpened: true,
        },
      },
    });
  });

  it('stays inert before settings initialization', async () => {
    const store = setup({ initialized: false });
    await flush();

    expect(desktop.getHealth).not.toHaveBeenCalled();
    expect(store.bannerVisible()).toBe(false);
    expect(store.chipVisible()).toBe(false);
  });

  it('stays inert on non-macOS platforms', async () => {
    const store = setup({ platform: 'win32' });
    await flush();

    expect(desktop.getHealth).not.toHaveBeenCalled();
    expect(store.active()).toBe(false);
  });

  it('stays inert while Computer Use is disabled', async () => {
    const store = setup({ enabled: false });
    await flush();

    expect(desktop.getHealth).not.toHaveBeenCalled();
    expect(store.bannerVisible()).toBe(false);
  });

  it('refreshes exactly once when Computer Use becomes enabled and does not poll', async () => {
    const store = setup({ enabled: false });
    await flush();
    expect(desktop.getHealth).not.toHaveBeenCalled();

    setEnabled(true);
    await flush();

    expect(desktop.getHealth).toHaveBeenCalledOnce();
    expect(store.health()).not.toBeNull();
    expect(store.missingPermissions()).toEqual(['screen-recording', 'accessibility']);

    await flush();
    expect(desktop.getHealth).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent refreshes through one in-flight promise', async () => {
    let release: ((value: ReturnType<typeof healthResponse>) => void) | null = null;
    desktop.getHealth.mockImplementation(() =>
      new Promise((resolve) => { release = resolve; }));
    const store = setup();

    const first = store.refresh();
    const second = store.refresh();
    expect(desktop.getHealth).toHaveBeenCalledOnce();
    release?.(healthResponse(health()));
    await Promise.all([first, second]);
  });

  it('retains the last good health value on a transient refresh failure', async () => {
    const store = setup();
    await flush();
    expect(store.health()).not.toBeNull();

    desktop.getHealth.mockResolvedValueOnce({
      success: false,
      error: { message: 'transient failure' },
    });
    await store.refresh();

    expect(store.health()).not.toBeNull();
    expect(store.error()).toBe('transient failure');
  });

  it('starts banner-only, collapses to chip-only on dismiss, and hides both when ready', async () => {
    const store = setup();
    await flush();

    expect(store.bannerVisible()).toBe(true);
    expect(store.chipVisible()).toBe(false);

    store.dismissBanner();
    expect(store.bannerVisible()).toBe(false);
    expect(store.chipVisible()).toBe(true);

    desktop.getHealth.mockResolvedValue(healthResponse(health({
      screenCapture: 'available',
      accessibility: 'available',
      input: 'available',
    })));
    await store.refresh();

    expect(store.bannerVisible()).toBe(false);
    expect(store.chipVisible()).toBe(false);
  });

  it('clears state on disable and starts a fresh banner period on re-enable', async () => {
    const store = setup();
    await flush();
    store.dismissBanner();
    expect(store.chipVisible()).toBe(true);

    setEnabled(false);
    await flush();
    expect(store.health()).toBeNull();
    expect(store.bannerVisible()).toBe(false);
    expect(store.chipVisible()).toBe(false);

    setEnabled(true);
    await flush();
    expect(store.bannerVisible()).toBe(true);
    expect(store.chipVisible()).toBe(false);
  });

  it('refreshes on window focus and document visibility, with listener cleanup', async () => {
    setup();
    await flush();
    expect(desktop.getHealth).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(desktop.getHealth).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(desktop.getHealth).toHaveBeenCalledTimes(3);

    TestBed.resetTestingModule();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(desktop.getHealth).toHaveBeenCalledTimes(3);
  });

  it('routes the requested permission enum and refreshes immediately after the action', async () => {
    const store = setup();
    await flush();
    desktop.getHealth.mockClear();

    await store.requestPermission('accessibility');

    expect(desktop.requestSystemPermission).toHaveBeenCalledExactlyOnceWith('accessibility');
    expect(desktop.getHealth).toHaveBeenCalledOnce();
    expect(store.error()).toBeNull();
  });

  it('deduplicates concurrent permission requests', async () => {
    let release: ((value: unknown) => void) | null = null;
    desktop.requestSystemPermission.mockImplementation(() =>
      new Promise((resolve) => { release = resolve; }));
    const store = setup();
    await flush();

    const first = store.requestPermission('screen-recording');
    const second = store.requestPermission('screen-recording');
    expect(desktop.requestSystemPermission).toHaveBeenCalledOnce();
    release?.({
      success: true,
      data: {
        decision: 'allowed',
        outcome: 'ok',
        data: {
          permission: 'screen-recording',
          state: 'available',
          nativeRequestAttempted: true,
          settingsOpened: false,
        },
      },
    });
    await Promise.all([first, second]);
  });

  it('surfaces the manual instruction when both settings navigations fail', async () => {
    desktop.requestSystemPermission.mockResolvedValue({
      success: true,
      data: {
        decision: 'allowed',
        outcome: 'ok',
        data: {
          permission: 'screen-recording',
          state: 'missing_permission',
          nativeRequestAttempted: true,
          settingsOpened: false,
        },
      },
    });
    const store = setup();
    await flush();

    await store.requestPermission('screen-recording');

    expect(store.error()).toBe(MANUAL_SETTINGS_INSTRUCTION);
  });

  it('surfaces a denied permission request as a safe error', async () => {
    desktop.requestSystemPermission.mockResolvedValue({
      success: true,
      data: { decision: 'denied', outcome: 'not_run', reason: 'computer_use_disabled' },
    });
    const store = setup();
    await flush();

    await store.requestPermission('screen-recording');

    expect(store.error()).toBe('computer_use_disabled');
  });
});
