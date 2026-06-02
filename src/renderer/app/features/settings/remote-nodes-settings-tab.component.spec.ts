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

    expect(connectionConfig['host']).toBe('100.101.102.103');
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

    expect(connectionConfig['host']).toBe('studio-mac.tailnet-abcd.ts.net');
    expect(new URL(pairingLink).searchParams.get('host')).toBe('studio-mac.tailnet-abcd.ts.net');
  });
});
