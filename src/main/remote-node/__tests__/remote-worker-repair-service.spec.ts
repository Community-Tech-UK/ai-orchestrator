import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerNodeRegistry } from '../worker-node-registry';
import { NodeIdentityStore } from '../node-identity-store';
import { RemoteWorkerRepairTracker } from '../remote-worker-repair-tracker';
import { RemoteWorkerRepairService } from '../remote-worker-repair-service';
import type { NodeIdentity, WorkerNodeInfo } from '../../../shared/types/worker-node.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const now = 1_800_000_000_000;

function identity(overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    sessionId: 'session-node-1',
    nodeId: 'node-1',
    nodeName: 'Windows PC',
    transportToken: 'transport-token',
    token: 'transport-token',
    recoveryToken: 'recovery-token',
    issuedAt: now - 10_000,
    createdAt: now - 10_000,
    lastSeenAt: now - 5_000,
    authMethod: 'pairing_credential',
    ...overrides,
  };
}

function liveNode(overrides: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id: 'node-1',
    name: 'Windows PC',
    address: '',
    status: 'connected',
    connectedAt: now - 1_000,
    lastHeartbeat: now - 500,
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 32_768,
      availableMemoryMB: 16_000,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 2,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
    ...overrides,
  };
}

function decodeGeneratedPowerShell(command: string): string {
  const encoded = command.split('-EncodedCommand ')[1];
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('RemoteWorkerRepairService', () => {
  let store: NodeIdentityStore;
  let registry: WorkerNodeRegistry;
  let tracker: RemoteWorkerRepairTracker;
  let issuedCredentials: Array<{ label?: string; purpose?: string; allowedNodeId?: string }> = [];

  function service() {
    return new RemoteWorkerRepairService({
      auth: {
        listSessions: () => store.getAll(),
        issuePairingCredential: (options: { label?: string; purpose?: string; allowedNodeId?: string }) => {
          issuedCredentials.push(options);
          return {
            token: 'placeholder-repair-token',
            label: options.label,
            createdAt: now,
            expiresAt: now + 30 * 60_000,
          };
        },
      },
      registry,
      tracker,
      now: () => now,
      getConfig: () => ({
        enabled: true,
        serverHost: '0.0.0.0',
        serverPort: 4878,
        namespace: 'default',
        autoOffloadBrowser: true,
        autoOffloadAndroid: true,
        autoOffloadGpu: false,
        maxRemoteInstances: 20,
      }),
      getLocalIpv4Addresses: () => ['192.168.1.20'],
      getTailscaleIpv4Address: () => '100.101.102.103',
      getTailscaleMagicDnsName: () => 'studio.tailnet.ts.net',
    });
  }

  beforeEach(() => {
    store = new NodeIdentityStore();
    store.loadFromJson('{}');
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    tracker = new RemoteWorkerRepairTracker();
    issuedCredentials = [];
  });

  it('classifies a connected node as healthy and exposes service status action', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    registry.registerNode(liveNode());

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'healthy',
      trustedPlatform: 'win32',
      recommendedAction: 'none',
      availableActions: ['check_service_status'],
    }));
  });

  it('keeps connected nodes on the healthy path when a duplicate registration is rejected', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    registry.registerNode(liveNode({ connectedAt: now - 2_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic.status).toBe('healthy');
    expect(diagnostic.recommendedAction).toBe('none');
    expect(diagnostic.summary).toContain('duplicate worker or stale config');
    expect(diagnostic.lastRejectedRegistration?.count).toBe(1);
  });

  it('classifies recent rejection after lastSeenAt as depaired and uses trusted Windows state', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platformHint: 'linux',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic).toEqual(expect.objectContaining({
      status: 'depaired',
      trustedPlatform: 'win32',
      platformHint: 'linux',
      recommendedAction: 'copy_windows_command',
    }));
  });

  it('requires platform choice for depaired registered nodes without a trusted platform', () => {
    store.set(identity());
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      platformHint: 'win32',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic.status).toBe('depaired');
    expect(diagnostic.trustedPlatform).toBeUndefined();
    expect(diagnostic.platformHint).toBe('win32');
    expect(diagnostic.recommendedAction).toBe('choose_platform');
  });

  it('classifies disconnected registered nodes without newer rejection as unreachable', () => {
    store.set(identity({ lastSeenAt: now - 500 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 5_000,
    });

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic.status).toBe('unreachable');
    expect(diagnostic.recommendedAction).toBe('check_connectivity');
  });

  it('classifies rejected unregistered node ids as unknown and uses sanitized rejection name', () => {
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const diagnostic = service().diagnose('node-1');

    expect(diagnostic).toEqual(expect.objectContaining({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      status: 'unknown',
      recommendedAction: 're_pair',
      hasCoordinatorRecoveryToken: false,
    }));
  });

  it('generates a Windows command with scoped one-time credential and safe metadata', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const command = service().generateRepairCommand({ nodeId: 'node-1' });

    expect(issuedCredentials).toEqual([
      expect.objectContaining({
        label: 'Repair Windows PC',
        purpose: 'repair',
        allowedNodeId: 'node-1',
      }),
    ]);
    expect(command).toEqual(expect.objectContaining({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platform: 'win32',
      configPath: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
      serviceId: 'ai-orchestrator-worker',
      primaryCoordinatorUrl: 'ws://studio.tailnet.ts.net:4878',
      coordinatorUrls: [
        'ws://studio.tailnet.ts.net:4878',
        'ws://100.101.102.103:4878',
        'ws://192.168.1.20:4878',
      ],
    }));
    expect(command.command).toContain('-EncodedCommand');
    expect(command.command).not.toContain('placeholder-repair-token');
    expect(command.redactedPreview).not.toContain('placeholder-repair-token');

    const decoded = decodeGeneratedPowerShell(command.command);
    expect(decoded).toContain('ConvertFrom-Json');
    expect(decoded).toContain('nodeToken');
    expect(decoded).toContain('recoveryToken');
    expect(decoded).toContain('System.Text.UTF8Encoding');
    expect(decoded).toContain('WriteAllText');
    expect(decoded).not.toContain('Set-Content');
    expect(decoded).toContain('Restart-Service');
  });

  it('generates a Windows command after explicit operator confirmation when platform is unknown', () => {
    store.set(identity());
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      platformHint: 'win32',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const command = service().generateRepairCommand({
      nodeId: 'node-1',
      platform: 'win32',
      operatorConfirmedPlatform: true,
    });

    expect(command.platform).toBe('win32');
    expect(issuedCredentials).toEqual([
      expect.objectContaining({ purpose: 'repair', allowedNodeId: 'node-1' }),
    ]);
  });

  it('rejects repair commands for healthy nodes and unreachable nodes without failed auth evidence', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    registry.registerNode(liveNode());

    expect(() => service().generateRepairCommand({ nodeId: 'node-1' })).toThrow(/healthy/i);

    registry.deregisterNode('node-1');
    expect(() => service().generateRepairCommand({ nodeId: 'node-1' })).toThrow(/rejected-registration/i);
  });

  it('does not let operator confirmation override a trusted non-Windows platform', () => {
    store.set(identity({ platform: 'linux', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      platformHint: 'win32',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    expect(() => service().generateRepairCommand({
      nodeId: 'node-1',
      platform: 'win32',
      operatorConfirmedPlatform: true,
    })).toThrow(/trusted non-Windows/i);
  });

  it('generates a Windows command that reports write and service restart failures clearly', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const command = service().generateRepairCommand({ nodeId: 'node-1' });
    const decoded = decodeGeneratedPowerShell(command.command);

    expect(decoded).toContain('Failed to write worker config');
    expect(decoded).toContain('requires an elevated PowerShell session');
    expect(decoded).toContain('Start-Service');
    expect(decoded).toContain('could not be restarted or started');
    expect(decoded).toContain('-ErrorAction Stop');
  });

  it('does not issue a repair credential when no coordinator URL is available', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const unavailable = new RemoteWorkerRepairService({
      auth: {
        listSessions: () => store.getAll(),
        issuePairingCredential: (options: { label?: string; purpose?: string; allowedNodeId?: string }) => {
          issuedCredentials.push(options);
          return {
            token: 'placeholder-repair-token',
            label: options.label,
            createdAt: now,
            expiresAt: now + 30 * 60_000,
          };
        },
      },
      registry,
      tracker,
      now: () => now,
      getConfig: () => ({
        enabled: true,
        serverHost: '0.0.0.0',
        serverPort: 4878,
        namespace: 'default',
        autoOffloadBrowser: true,
        autoOffloadAndroid: true,
        autoOffloadGpu: false,
        maxRemoteInstances: 20,
      }),
      getLocalIpv4Addresses: () => [],
      getTailscaleIpv4Address: () => null,
      getTailscaleMagicDnsName: () => null,
    });

    expect(() => unavailable.generateRepairCommand({ nodeId: 'node-1' })).toThrow(/coordinator URL/i);
    expect(issuedCredentials).toEqual([]);
  });

  it('blocks command generation for mTLS-only coordinator configurations', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const blocked = new RemoteWorkerRepairService({
      auth: {
        listSessions: () => store.getAll(),
        issuePairingCredential: vi.fn(),
      },
      registry,
      tracker,
      now: () => now,
      getConfig: () => ({
        enabled: true,
        serverHost: '0.0.0.0',
        serverPort: 4878,
        namespace: 'default',
        autoOffloadBrowser: true,
        autoOffloadAndroid: true,
        autoOffloadGpu: false,
        maxRemoteInstances: 20,
        tlsCertPath: '/cert.pem',
        tlsKeyPath: '/key.pem',
        tlsCaPath: '/ca.pem',
      }),
      getLocalIpv4Addresses: () => ['192.168.1.20'],
      getTailscaleIpv4Address: () => null,
      getTailscaleMagicDnsName: () => null,
    });

    expect(blocked.diagnose('node-1')).toEqual(expect.objectContaining({
      recommendedAction: 'configure_tls',
      coordinatorUrls: [],
    }));
    expect(() => blocked.generateRepairCommand({ nodeId: 'node-1' })).toThrow(/TLS/i);
  });

  it('does not generate wss candidates for auto self-signed TLS repair mode', () => {
    store.set(identity({ platform: 'win32', platformSeenAt: now - 6_000 }));
    tracker.recordRejectedRegistration({
      nodeId: 'node-1',
      reason: 'Invalid or expired pairing token',
      now: now - 1_000,
    });

    const blocked = new RemoteWorkerRepairService({
      auth: {
        listSessions: () => store.getAll(),
        issuePairingCredential: vi.fn(),
      },
      registry,
      tracker,
      now: () => now,
      getConfig: () => ({
        enabled: true,
        serverHost: '0.0.0.0',
        serverPort: 4878,
        namespace: 'default',
        autoOffloadBrowser: true,
        autoOffloadAndroid: true,
        autoOffloadGpu: false,
        maxRemoteInstances: 20,
        tlsMode: 'auto',
        tlsCertPath: '/self-signed-cert.pem',
        tlsKeyPath: '/self-signed-key.pem',
      }),
      getLocalIpv4Addresses: () => ['192.168.1.20'],
      getTailscaleIpv4Address: () => '100.101.102.103',
      getTailscaleMagicDnsName: () => 'studio.tailnet.ts.net',
    });

    const diagnostic = blocked.diagnose('node-1');

    expect(diagnostic.recommendedAction).toBe('configure_tls');
    expect(diagnostic.coordinatorUrls).toEqual([]);
    expect(() => blocked.generateRepairCommand({ nodeId: 'node-1' })).toThrow(/TLS/i);
  });
});
