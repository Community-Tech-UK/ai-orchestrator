import { describe, expect, it } from 'vitest';
import { buildRemoteNodeRoster } from './remote-node-roster-service';
import type {
  NodeIdentity,
  WorkerNodeCapabilities,
  WorkerNodeInfo,
} from '../../shared/types/worker-node.types';

function makeCapabilities(overrides: Partial<WorkerNodeCapabilities> = {}): WorkerNodeCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 32768,
    availableMemoryMB: 24000,
    supportedClis: ['claude', 'codex'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: true,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\work'],
    browsableRoots: ['C:\\work'],
    discoveredProjects: [],
    ...overrides,
  };
}

function makeNode(overrides: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id: 'node-1',
    name: 'windows-pc',
    address: '100.106.40.97',
    capabilities: makeCapabilities(),
    status: 'connected',
    connectedAt: 3000,
    lastHeartbeat: 4000,
    activeInstances: 1,
    latencyMs: 18,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    sessionId: 'session-1',
    nodeId: 'node-1',
    nodeName: 'windows-pc',
    transportToken: 'transport-secret',
    token: 'transport-secret',
    recoveryToken: 'recovery-secret',
    issuedAt: 1000,
    createdAt: 1000,
    lastSeenAt: 2000,
    authMethod: 'pairing_credential',
    pairingLabel: 'Studio PC',
    platform: 'win32',
    platformSeenAt: 2000,
    ...overrides,
  };
}

describe('buildRemoteNodeRoster', () => {
  it('merges live node details with persisted identity metadata', () => {
    const roster = buildRemoteNodeRoster([makeNode()], [makeIdentity()]);

    expect(roster).toEqual([
      expect.objectContaining({
        id: 'node-1',
        name: 'windows-pc',
        status: 'connected',
        connected: true,
        address: '100.106.40.97',
        platform: 'win32',
        arch: 'x64',
        activeInstances: 1,
        maxConcurrentInstances: 4,
        lastHeartbeat: 4000,
        lastAuthenticatedAt: 2000,
        pairingLabel: 'Studio PC',
        authMethod: 'pairing_credential',
        supportedClis: ['claude', 'codex'],
        workingDirectories: ['C:\\work'],
      }),
    ]);
  });

  it('includes disconnected registered nodes from persisted identity data', () => {
    const roster = buildRemoteNodeRoster([], [
      makeIdentity({
        nodeId: 'node-2',
        nodeName: 'noahlaptop',
        platform: 'darwin',
      }),
    ]);

    expect(roster).toEqual([
      expect.objectContaining({
        id: 'node-2',
        name: 'noahlaptop',
        status: 'disconnected',
        connected: false,
        platform: 'darwin',
        activeInstances: 0,
        maxConcurrentInstances: 0,
        supportedClis: [],
        workingDirectories: [],
      }),
    ]);
  });

  it('includes connected unpersisted nodes without inventing auth metadata', () => {
    const roster = buildRemoteNodeRoster([
      makeNode({
        id: 'node-3',
        name: 'lab-box',
        capabilities: makeCapabilities({ platform: 'linux' }),
      }),
    ], []);

    expect(roster).toEqual([
      expect.objectContaining({
        id: 'node-3',
        name: 'lab-box',
        status: 'connected',
        connected: true,
        platform: 'linux',
      }),
    ]);
    expect(roster[0]).not.toHaveProperty('pairingLabel');
    expect(roster[0]).not.toHaveProperty('authMethod');
  });

  it('never exposes transport, recovery, or pairing token fields', () => {
    const roster = buildRemoteNodeRoster([makeNode()], [makeIdentity()]);
    const serialized = JSON.stringify(roster);

    expect(serialized).not.toContain('transport-secret');
    expect(serialized).not.toContain('recovery-secret');
    expect(roster[0]).not.toHaveProperty('transportToken');
    expect(roster[0]).not.toHaveProperty('recoveryToken');
    expect(roster[0]).not.toHaveProperty('token');
  });
});
