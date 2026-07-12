import {
  CUSTOM_ELEMENTS_SCHEMA,
  ɵresolveComponentResources as resolveComponentResources,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseSettingsTabComponent } from './computer-use-settings-tab.component';
import { ComputerUsePermissionStore } from '../../core/state/computer-use-permission.store';
import { SettingsStore } from '../../core/state/settings.store';
import { DesktopGatewayIpcService } from '../../core/services/ipc/desktop-gateway-ipc.service';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import type {
  DesktopHealthData,
  DesktopSystemPermission,
} from '../../../../shared/types/desktop-gateway.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, './computer-use-settings-tab.component.html'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('computer-use-settings-tab.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeHealth(overrides: Partial<DesktopHealthData> = {}): DesktopHealthData {
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

function makePermissionStore(health: DesktopHealthData | null) {
  return {
    health: signal(health),
    loading: signal(false),
    error: signal<string | null>(null),
    requesting: signal<DesktopSystemPermission | null>(null),
    refresh: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => undefined),
  };
}

const okList = { success: true as const, data: { decision: 'allowed', outcome: 'ok', data: { apps: [], grants: [], entries: [] } } };

describe('ComputerUseSettingsTabComponent', () => {
  let permissionStore: ReturnType<typeof makePermissionStore>;
  let settings: ReturnType<typeof signal<AppSettings>>;
  const desktop = {
    listApps: vi.fn(async () => okList),
    listGrants: vi.fn(async () => okList),
    getAuditLog: vi.fn(async () => okList),
    revokeGrant: vi.fn(async () => ({ success: true })),
  };

  function configure(options: { enabled?: boolean; health?: DesktopHealthData | null } = {}) {
    permissionStore = makePermissionStore(options.health ?? makeHealth());
    settings = signal<AppSettings>({
      ...DEFAULT_SETTINGS,
      computerUseEnabled: options.enabled ?? true,
    });

    TestBed.overrideComponent(ComputerUseSettingsTabComponent, {
      set: {
        imports: [],
        template,
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });

    TestBed.configureTestingModule({
      imports: [ComputerUseSettingsTabComponent],
      providers: [
        { provide: ComputerUsePermissionStore, useValue: permissionStore },
        {
          provide: SettingsStore,
          useValue: {
            settings,
            metadata: [],
            get: vi.fn((key: keyof AppSettings) => settings()[key]),
            set: vi.fn(),
          },
        },
        { provide: DesktopGatewayIpcService, useValue: desktop },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
  }

  function render() {
    const fixture = TestBed.createComponent(ComputerUseSettingsTabComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('renders permission health from the shared store without its own health request', () => {
    configure();
    const fixture = render();

    expect(fixture.nativeElement.textContent).toContain('Screen Recording');
    expect(fixture.nativeElement.textContent).toContain('Permission needed');
    expect(permissionStore.refresh).toHaveBeenCalledOnce();
  });

  it('requests permissions through the shared store action', () => {
    configure();
    const fixture = render();

    const button = fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Open Screen Recording settings"]');
    button?.click();

    expect(permissionStore.requestPermission)
      .toHaveBeenCalledExactlyOnceWith('screen-recording');
  });

  it('disables permission actions while Computer Use is off', () => {
    configure({ enabled: false });
    const fixture = render();

    const button = fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Open Screen Recording settings"]');
    expect(button?.disabled).toBe(true);
  });

  it('disables permission actions and shows progress while a request is in flight', () => {
    configure();
    permissionStore.requesting.set('screen-recording');
    const fixture = render();

    const button = fixture.nativeElement
      .querySelector<HTMLButtonElement>('[aria-label="Open Screen Recording settings"]');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('Opening…');
  });

  it('surfaces the shared store error alongside local tab errors', () => {
    configure();
    permissionStore.error.set('Could not open System Settings. Open Privacy & Security manually.');
    const fixture = render();

    expect(fixture.nativeElement.textContent)
      .toContain('Open Privacy & Security manually');
  });

  it('keeps apps, grants, and audit loading local to the tab', () => {
    configure();
    render();

    expect(desktop.listApps).toHaveBeenCalledOnce();
    expect(desktop.listGrants).toHaveBeenCalledOnce();
    expect(desktop.getAuditLog).toHaveBeenCalledOnce();
  });
});
