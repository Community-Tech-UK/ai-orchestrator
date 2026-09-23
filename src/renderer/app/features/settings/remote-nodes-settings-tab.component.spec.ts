import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, type WritableSignal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService, type RemoteNodeServerStatus } from '../../core/services/ipc/remote-node-ipc.service';
import { PairBothIpcService } from '../../core/services/ipc/pair-both-ipc.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { RemoteNodeDetailAction } from './remote-node-detail.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './remote-nodes-settings-tab.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('remote-nodes-settings-tab.component.html')) {
    return Promise.resolve(template);
  }
  // Nested child templates/styles (Detail's templateUrl, every styleUrl) are
  // stubbed blank — these tests exercise the parent's own IA and wiring, not
  // the children's rendered markup (covered by their own specs).
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeRosterEntry(overrides: Partial<RemoteNodeRosterEntry> & { id: string }): RemoteNodeRosterEntry {
  return {
    name: overrides.id,
    status: 'connected',
    address: '100.64.1.2',
    connected: true,
    supportedClis: [],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: [],
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16384,
      availableMemoryMB: 8192,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
    ...overrides,
  };
}

describe('RemoteNodesSettingsTabComponent', () => {
  const store = {
    remoteNodesServerPort: vi.fn(() => 4878),
    remoteNodesServerHost: vi.fn(() => '0.0.0.0'),
    remoteNodesNamespace: vi.fn(() => 'default'),
    remoteNodesRequireTls: vi.fn(() => false),
    remoteNodesTlsMode: vi.fn(() => 'auto'),
    remoteNodesAutoOffloadBrowser: vi.fn(() => true),
    remoteNodesAutoOffloadAndroid: vi.fn(() => true),
    remoteNodesAutoOffloadGpu: vi.fn(() => false),
    remoteNodesRegisteredNodes: vi.fn(() => ({})),
    remoteNodesEnrollmentToken: vi.fn(() => 'manual-token'),
    remoteNodesEnabled: vi.fn(() => true),
    harnessRole: vi.fn(() => 'coordinator'),
    workerMode: vi.fn(() => ({ role: 'coordinator' })),
    set: vi.fn(),
  };

  const ipc = {
    getServerStatus: vi.fn(async () => ({ running: false }) as RemoteNodeServerStatus),
    listNodes: vi.fn(async () => [] as RemoteNodeRosterEntry[]),
    listPairingCredentials: vi.fn(async () => []),
    updateAndroidAutomation: vi.fn(),
    updateBrowserAutomation: vi.fn(),
    resetConnection: vi.fn(),
    revokeNode: vi.fn(async () => undefined),
    runBrowserLogin: vi.fn(async () => undefined),
    onNodeEvent: vi.fn(() => () => undefined),
    onNodesChanged: vi.fn(() => () => undefined),
  };

  const pairBoth = {
    startCoordinatorPairing: vi.fn(),
    stopCoordinatorPairing: vi.fn(),
    getCoordinatorState: vi.fn(async () => null),
  };

  const clipboard = {
    copyText: vi.fn(async () => ({ ok: true as const })),
  };

  let fixture: ComponentFixture<RemoteNodesSettingsTabComponent>;
  let component: RemoteNodesSettingsTabComponent;

  beforeEach(async () => {
    vi.clearAllMocks();
    store.remoteNodesEnabled.mockReturnValue(true);
    ipc.getServerStatus.mockResolvedValue({ running: false } as RemoteNodeServerStatus);
    ipc.listNodes.mockResolvedValue([]);
    ipc.listPairingCredentials.mockResolvedValue([]);
    ipc.onNodeEvent.mockReturnValue(() => undefined);
    ipc.onNodesChanged.mockReturnValue(() => undefined);

    await TestBed.configureTestingModule({
      imports: [RemoteNodesSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: RemoteNodeIpcService, useValue: ipc },
        { provide: PairBothIpcService, useValue: pairBoth },
        { provide: CLIPBOARD_SERVICE, useValue: clipboard },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteNodesSettingsTabComponent);
    component = fixture.componentInstance;
  });

  it('prefers the Tailscale IP when generating worker pairing connection details', () => {
    (
      component as unknown as {
        serverStatus: WritableSignal<RemoteNodeServerStatus>;
      }
    ).serverStatus.set({
      running: true,
      host: '0.0.0.0',
      port: 4878,
      localIps: ['192.168.1.50', '100.101.102.103'],
      tailscaleIp: '100.101.102.103',
      requireTls: false,
    });

    const connectionConfig = (
      component as unknown as {
        buildConnectionConfig: (token: string) => Record<string, unknown>;
      }
    ).buildConnectionConfig('pair-token');
    const pairingLink = (
      component as unknown as {
        buildPairingLink: (token: string) => string;
      }
    ).buildPairingLink('pair-token');

    expect(connectionConfig).toMatchObject({
      authToken: 'pair-token',
      coordinatorUrl: 'ws://100.101.102.103:4878',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    });
    expect(connectionConfig).not.toHaveProperty('token');
    expect(connectionConfig).not.toHaveProperty('host');
    expect(new URL(pairingLink).searchParams.get('host')).toBe('100.101.102.103');
  });

  it('prefers the Tailscale MagicDNS name over the Tailscale IP', () => {
    (
      component as unknown as {
        serverStatus: WritableSignal<RemoteNodeServerStatus & { tailscaleDnsName: string }>;
      }
    ).serverStatus.set({
      running: true,
      host: '0.0.0.0',
      port: 4878,
      localIps: ['192.168.1.50', '100.101.102.103'],
      tailscaleIp: '100.101.102.103',
      tailscaleDnsName: 'studio-mac.tailnet-abcd.ts.net',
      requireTls: false,
    });

    const connectionConfig = (
      component as unknown as {
        buildConnectionConfig: (token: string) => Record<string, unknown>;
      }
    ).buildConnectionConfig('pair-token');
    const pairingLink = (
      component as unknown as {
        buildPairingLink: (token: string) => string;
      }
    ).buildPairingLink('pair-token');

    expect(connectionConfig['coordinatorUrl']).toBe('ws://studio-mac.tailnet-abcd.ts.net:4878');
    expect(new URL(pairingLink).searchParams.get('host')).toBe('studio-mac.tailnet-abcd.ts.net');
  });

  it('builds the recommended aio-worker pair command from the pairing link', () => {
    (
      component as unknown as {
        serverStatus: WritableSignal<RemoteNodeServerStatus>;
      }
    ).serverStatus.set({
      running: true,
      host: '0.0.0.0',
      port: 4878,
      tailscaleDnsName: 'studio-mac.tailnet-abcd.ts.net',
      requireTls: false,
    });

    const command = (
      component as unknown as {
        buildPairingCommand: (token: string) => string;
      }
    ).buildPairingCommand('pair-token');

    expect(command).toBe(
      'aio-worker pair "ai-orchestrator://remote-node/pair?host=studio-mac.tailnet-abcd.ts.net&port=4878&namespace=default&token=pair-token&requireTls=false"',
    );
  });

  it('counts degraded roster entries as connected when the socket is still live', async () => {
    ipc.listNodes.mockResolvedValueOnce([
      {
        id: 'node-degraded',
        name: 'windows-pc',
        status: 'degraded',
        connected: true,
        address: '100.64.1.2',
        supportedClis: [],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        activeInstances: 0,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 8,
          totalMemoryMB: 16384,
          availableMemoryMB: 8192,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 4,
          workingDirectories: [],
          browsableRoots: [],
          discoveredProjects: [],
        },
      },
    ]);

    await (
      component as unknown as {
        refreshNodes: () => Promise<void>;
      }
    ).refreshNodes();

    expect(
      (
        component as unknown as {
          connectedCount: WritableSignal<number>;
        }
      ).connectedCount(),
    ).toBe(1);
  });

  it('does not count connecting roster entries as connected without a live socket flag', async () => {
    ipc.listNodes.mockResolvedValueOnce([
      {
        id: 'node-connecting',
        name: 'windows-pc',
        status: 'connecting',
        connected: false,
        address: '100.64.1.2',
        supportedClis: [],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        activeInstances: 0,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 8,
          totalMemoryMB: 16384,
          availableMemoryMB: 8192,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 4,
          workingDirectories: [],
          browsableRoots: [],
          discoveredProjects: [],
        },
      },
    ]);

    await (
      component as unknown as {
        refreshNodes: () => Promise<void>;
      }
    ).refreshNodes();

    expect(
      (
        component as unknown as {
          connectedCount: WritableSignal<number>;
        }
      ).connectedCount(),
    ).toBe(0);
  });

  describe('task-based section navigation (Task 3)', () => {
    it('explains how to enable pairing when the remote-node server is disabled', () => {
      store.remoteNodesEnabled.mockReturnValue(false);
      fixture.detectChanges();
      (fixture.nativeElement.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
      fixture.detectChanges();

      const pairing = fixture.nativeElement.querySelector('#remote-nodes-panel-pairing');
      expect(pairing?.textContent).toContain('Enable the remote-node server in Overview');
    });
    it('renders four section tabs with matching tab panels, only the active panel visible', () => {
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      expect(Array.from(tabs).map((tab) => (tab as HTMLElement).textContent?.trim())).toEqual([
        'Overview',
        'Pairing',
        'Computers',
        'Advanced',
      ]);

      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-overview')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-pairing')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-computers')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-advanced')).toBeNull();
    });

    it('switches the visible panel when a different tab is selected', () => {
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>;
      tabs[2].click(); // Computers
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-overview')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-computers')).not.toBeNull();
    });

    it('shows the Computer Role and Enable Remote Node Server controls on Overview', () => {
      fixture.detectChanges();

      const overview = fixture.nativeElement.querySelector('#remote-nodes-panel-overview');
      expect(overview?.textContent).toContain('Computer Role');
      expect(overview?.textContent).toContain('Enable Remote Node Server');
    });

    it('navigates to Advanced from the Overview "Server & advanced settings" action', () => {
      fixture.detectChanges();
      (fixture.componentInstance as unknown as { goToSection: (id: string) => void }).goToSection(
        'advanced',
      );
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-advanced')).not.toBeNull();
    });
  });

  describe('Computers list/detail action wiring preserves every existing remote-node action (Task 4)', () => {
    beforeEach(() => {
      fixture.detectChanges();
    });

    function onDetailAction(action: RemoteNodeDetailAction): void {
      (
        fixture.componentInstance as unknown as { onDetailAction: (a: RemoteNodeDetailAction) => void }
      ).onDetailAction(action);
    }

    it('routes a revoke action to the existing confirm + revokeNode + refresh flow', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      onDetailAction({ type: 'revoke', nodeId: 'node-a' });

      expect(ipc.revokeNode).toHaveBeenCalledWith('node-a');
    });

    it('does not revoke when the confirmation dialog is declined', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      onDetailAction({ type: 'revoke', nodeId: 'node-a' });

      expect(ipc.revokeNode).not.toHaveBeenCalled();
    });

    it('routes a reset-connection action to the existing resetConnection flow', async () => {
      (
        component as unknown as {
          liveNodes: WritableSignal<RemoteNodeRosterEntry[]>;
        }
      ).liveNodes.set([makeRosterEntry({ id: 'node-a', status: 'connected' })]);
      ipc.resetConnection.mockResolvedValue(true);

      onDetailAction({ type: 'reset-connection', nodeId: 'node-a' });
      await Promise.resolve();

      expect(ipc.resetConnection).toHaveBeenCalledWith('node-a');
    });

    it('routes a configure-browser action to the existing enable-confirmation + updateBrowserAutomation flow', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      ipc.updateBrowserAutomation.mockResolvedValue(null);

      onDetailAction({
        type: 'configure-browser',
        nodeId: 'node-a',
        config: { enabled: true, headless: false, profileDir: '/tmp/profile' },
        extensionRelayEnabled: false,
      });
      await Promise.resolve();

      expect(window.confirm).toHaveBeenCalled();
      expect(ipc.updateBrowserAutomation).toHaveBeenCalledWith(
        'node-a',
        { enabled: true, headless: false, profileDir: '/tmp/profile' },
        { enabled: false },
      );
    });

    it('routes a configure-android action to the existing updateAndroidAutomation flow', async () => {
      ipc.updateAndroidAutomation.mockResolvedValue(null);

      onDetailAction({
        type: 'configure-android',
        nodeId: 'node-a',
        config: {
          enabled: false,
          headlessEmulator: true,
          maxEmulators: 1,
          allowPhysicalDevices: true,
          injectMaestroMcp: false,
        },
      });
      await Promise.resolve();

      expect(ipc.updateAndroidAutomation).toHaveBeenCalledWith('node-a', {
        enabled: false,
        headlessEmulator: true,
        maxEmulators: 1,
        allowPhysicalDevices: true,
        injectMaestroMcp: false,
      });
    });

    it('routes a run-login action to the existing confirm + runBrowserLogin flow', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      onDetailAction({ type: 'run-login', nodeId: 'node-a', url: 'https://example.com' });
      await Promise.resolve();

      expect(ipc.runBrowserLogin).toHaveBeenCalledWith('node-a', 'https://example.com');
    });

    it('routes a copy action to the existing clipboard flow', async () => {
      onDetailAction({ type: 'copy', value: 'some-diagnostics-json', description: 'remote node diagnostics' });
      await Promise.resolve();

      expect(clipboard.copyText).toHaveBeenCalledWith('some-diagnostics-json', { label: 'remote node token' });
    });
  });
});
