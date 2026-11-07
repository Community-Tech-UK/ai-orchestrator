import { ConfirmService } from '../../shared/confirm/confirm.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, type WritableSignal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { RemoteNodeIpcService, type RemoteNodeServerStatus } from '../../core/services/ipc/remote-node-ipc.service';
import { PairBothIpcService } from '../../core/services/ipc/pair-both-ipc.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import type { RemotePairingCredentialInfo, RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
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
    remoteNodesRegisteredNodes: vi.fn(() => ({})),
    remoteNodesEnrollmentToken: vi.fn(() => 'EXAMPLE_TOKEN'),
    remoteNodesEnabled: vi.fn(() => true),
    harnessRole: vi.fn(() => 'coordinator'),
    workerMode: vi.fn(() => ({ role: 'coordinator' })),
    computers: vi.fn(() => []),
    set: vi.fn(),
  };

  const ipc = {
    getServerStatus: vi.fn(async () => ({ running: false }) as RemoteNodeServerStatus),
    getTestMachine: vi.fn(async () => ({ ok: true, testMachine: null, today: null })),
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
    store.remoteNodesEnrollmentToken.mockReturnValue('EXAMPLE_TOKEN');
    ipc.getServerStatus.mockResolvedValue({ running: false } as RemoteNodeServerStatus);
    ipc.listNodes.mockResolvedValue([]);
    ipc.listPairingCredentials.mockResolvedValue([]);
    ipc.onNodeEvent.mockReturnValue(() => undefined);
    ipc.onNodesChanged.mockReturnValue(() => undefined);

    await TestBed.configureTestingModule({
      imports: [RemoteNodesSettingsTabComponent],
      providers: [
        { provide: ElectronIpcService, useValue: { platform: 'darwin' } },
        { provide: SettingsStore, useValue: store },
        { provide: RemoteNodeIpcService, useValue: ipc },
        { provide: PairBothIpcService, useValue: pairBoth },
        { provide: CLIPBOARD_SERVICE, useValue: clipboard },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteNodesSettingsTabComponent);
    component = fixture.componentInstance;
  });

  function renderCopyToken(): HTMLButtonElement {
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('[role="tab"]')[3] as HTMLButtonElement).click();
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('[aria-label="Copy token"]') as HTMLButtonElement;
  }

  it('explains a missing token on focus and Escape while refusing to copy', async () => {
    store.remoteNodesEnrollmentToken.mockReturnValue('');
    const button = renderCopyToken();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.classList.contains('aio-reason-disabled')).toBe(true);
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
    const tooltipElement = document.querySelector('[role="tooltip"]')!;
    expect(tooltipElement.textContent).toContain('No token is set');
    expect(button.getAttribute('aria-describedby')).toContain(tooltipElement.id);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    button.click();
    await fixture.whenStable();
    expect(clipboard.copyText).not.toHaveBeenCalled();
    // The handler's guard also applies when called without DOM activation.
    await component.copyToken();
    expect(clipboard.copyText).not.toHaveBeenCalled();
  });

  it('keeps the Copy token name and tooltip and copies a populated token', async () => {
    const button = renderCopyToken();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.classList.contains('aio-reason-disabled')).toBe(false);
    const directive = fixture.debugElement.queryAll(By.directive(AioTooltipDirective))
      .find(element => element.nativeElement === button)!.injector.get(AioTooltipDirective);
    expect(directive.appTooltipDisabledReason()).toBeNull();
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    button.focus();
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Copy token');
    button.click();
    await fixture.whenStable();
    expect(clipboard.copyText).toHaveBeenCalledExactlyOnceWith('EXAMPLE_TOKEN', { label: 'computer pairing details' });
  });

  /** The tab opens on Computers; Overview is the third section. */
  function showOverview(): void {
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('[role="tab"]')[2] as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  it('names computers and keeps a configured connection switch separate from live readiness', () => {
    showOverview();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.section-title')?.textContent).toBe('Other computers');
    expect(root.textContent).toContain('Let your other computers connect');
    expect(root.textContent).toContain('Choose whether this Mac manages work');
    expect(root.textContent).toContain('Configured: On');
    expect(root.textContent).toContain('Not accepting connections');
    expect(root.textContent).not.toMatch(/Remote Nodes|Remote Node Server|\bworker\b|\bcoordinator\b/i);
    expect(root.querySelector<HTMLInputElement>('.toggle-input')?.checked).toBe(true);
  });

  it('shows a live listener even when the saved switch is off', () => {
    store.remoteNodesEnabled.mockReturnValue(false);
    (component as unknown as { serverStatus: WritableSignal<RemoteNodeServerStatus> }).serverStatus
      .set({ running: true, host: '127.0.0.1', port: 4878 });
    showOverview();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector<HTMLInputElement>('.toggle-input')?.checked).toBe(false);
    expect(root.textContent).toContain('Configured: Off');
    expect(root.textContent).toContain('Accepting connections');
    expect(root.textContent).toContain('127.0.0.1:4878');
  });

  it('uses the computer name in revocation while retaining the exact revoke target', async () => {
    (component as unknown as { liveNodes: WritableSignal<RemoteNodeRosterEntry[]> }).liveNodes
      .set([makeRosterEntry({ id: 'node-a', name: 'Studio PC', platform: 'win32' })]);
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);
    await component.revokeNode('node-a');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Revoke "Studio PC"? It will no longer be able to connect.' }));
    expect(ipc.revokeNode).toHaveBeenCalledWith('node-a');
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
    ).buildConnectionConfig('EXAMPLE_TOKEN');
    const pairingLink = (
      component as unknown as {
        buildPairingLink: (token: string) => string;
      }
    ).buildPairingLink('EXAMPLE_TOKEN');

    expect(connectionConfig).toMatchObject({
      authToken: 'EXAMPLE_TOKEN',
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
    ).buildConnectionConfig('EXAMPLE_TOKEN');
    const pairingLink = (
      component as unknown as {
        buildPairingLink: (token: string) => string;
      }
    ).buildPairingLink('EXAMPLE_TOKEN');

    expect(connectionConfig['coordinatorUrl']).toBe('ws://studio-mac.tailnet-abcd.ts.net:4878');
    expect(new URL(pairingLink).searchParams.get('host')).toBe('studio-mac.tailnet-abcd.ts.net');
    // The worker falls back to these when the MagicDNS name does not answer.
    expect(connectionConfig['coordinatorUrls']).toEqual(['ws://100.101.102.103:4878', 'ws://192.168.1.50:4878']);
    expect(new URL(pairingLink).searchParams.getAll('fallbackHost')).toEqual(['100.101.102.103', '192.168.1.50']);
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
    ).buildPairingCommand('EXAMPLE_TOKEN');

    expect(command).toBe(
      'aio-worker pair "ai-orchestrator://remote-node/pair?host=studio-mac.tailnet-abcd.ts.net&port=4878&namespace=default&token=EXAMPLE_TOKEN&requireTls=false"',
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
      expect(pairing?.textContent).toContain('Allow connections in Overview');
    });
    it('shows which session requested an agent-issued pairing credential', () => {
      fixture.detectChanges();
      (component as unknown as { pendingPairings: WritableSignal<RemotePairingCredentialInfo[]> }).pendingPairings.set([
        {
          token: 'EXAMPLE_TOKEN',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60 * 60_000,
          label: 'ct-test-mac',
          issuedBy: { instanceId: 'instance-1', name: 'Set up test Mac' },
        },
        { token: 'OTHER_TOKEN', createdAt: Date.now(), expiresAt: Date.now() + 60 * 60_000, label: 'Studio PC' },
      ]);
      (fixture.nativeElement.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
      fixture.detectChanges();

      const rows = Array.from(
        fixture.nativeElement.querySelectorAll('#remote-nodes-panel-pairing .node-row') as NodeListOf<HTMLElement>,
      ).map((row) => row.textContent ?? '');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toContain('Requested by Set up test Mac');
      expect(rows[1]).not.toContain('Requested by');
    });

    it('renders four section tabs with matching tab panels, only the active panel visible', () => {
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      expect(Array.from(tabs).map((tab) => (tab as HTMLElement).textContent?.trim())).toEqual([
        'Computers',
        'Pairing',
        'Overview',
        'Advanced',
      ]);

      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-computers')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-pairing')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-overview')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-advanced')).toBeNull();
    });

    it('switches the visible panel when a different tab is selected', () => {
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>;
      tabs[2].click(); // Overview
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-computers')).toBeNull();
      expect(fixture.nativeElement.querySelector('#remote-nodes-panel-overview')).not.toBeNull();
    });

    it('opens on the order of use, which shows even when connections are off', () => {
      store.remoteNodesEnabled.mockReturnValue(false);
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('#remote-nodes-panel-computers') as HTMLElement;
      expect(panel.querySelector('app-computers-list')).not.toBeNull();
      expect(panel.textContent).toContain('Allow connections in Overview to see connected computers.');
    });

    it('shows the Computer Role and Let your other computers connect controls on Overview', () => {
      showOverview();

      const overview = fixture.nativeElement.querySelector('#remote-nodes-panel-overview');
      expect(overview?.textContent).toContain('Computer Role');
      expect(overview?.textContent).toContain('Let your other computers connect');
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

    it('routes a revoke action to the existing confirm + revokeNode + refresh flow', async () => {
      vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);

      onDetailAction({ type: 'revoke', nodeId: 'node-a' });
      await Promise.resolve();

      expect(ipc.revokeNode).toHaveBeenCalledWith('node-a');
    });

    it('does not revoke when the confirmation dialog is declined', async () => {
      vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(false);

      onDetailAction({ type: 'revoke', nodeId: 'node-a' });
      await Promise.resolve();

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
      vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);
      ipc.updateBrowserAutomation.mockResolvedValue(null);

      onDetailAction({
        type: 'configure-browser',
        nodeId: 'node-a',
        config: { enabled: true, headless: false, profileDir: '/tmp/profile' },
        extensionRelayEnabled: false,
      });
      await Promise.resolve();

      expect(TestBed.inject(ConfirmService).confirm).toHaveBeenCalled();
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
      vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);

      onDetailAction({ type: 'run-login', nodeId: 'node-a', url: 'https://example.com' });
      await Promise.resolve();

      expect(ipc.runBrowserLogin).toHaveBeenCalledWith('node-a', 'https://example.com');
    });

    it('routes a copy action to the existing clipboard flow', async () => {
      onDetailAction({ type: 'copy', value: 'some-diagnostics-json', description: 'remote node diagnostics' });
      await Promise.resolve();

      expect(clipboard.copyText).toHaveBeenCalledWith('some-diagnostics-json', { label: 'computer pairing details' });
    });
  });
});
