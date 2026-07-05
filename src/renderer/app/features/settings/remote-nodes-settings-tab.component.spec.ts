import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, type WritableSignal } from '@angular/core';
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { RemoteNodeIpcService, type RemoteNodeServerStatus } from '../../core/services/ipc/remote-node-ipc.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

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
    set: vi.fn(),
  };

  const ipc = {
    getServerStatus: vi.fn(),
    listNodes: vi.fn(),
    listPairingCredentials: vi.fn(),
    updateAndroidAutomation: vi.fn(),
    onNodeEvent: vi.fn(),
    onNodesChanged: vi.fn(),
  };

  const clipboard = {
    copyText: vi.fn(async () => ({ ok: true as const })),
  };

  let fixture: ComponentFixture<RemoteNodesSettingsTabComponent>;
  let component: RemoteNodesSettingsTabComponent;

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [RemoteNodesSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: RemoteNodeIpcService, useValue: ipc },
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
});
