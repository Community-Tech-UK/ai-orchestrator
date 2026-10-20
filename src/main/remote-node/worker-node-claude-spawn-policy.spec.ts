import { describe, expect, it } from 'vitest';
import { NodeHeartbeatParamsSchema, NodeRegisterParamsSchema } from './rpc-schemas';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';

const caps: WorkerNodeCapabilities = { platform: 'win32', arch: 'x64', cpuCores: 8, totalMemoryMB: 16000, availableMemoryMB: 8000,
  supportedClis: ['claude'], hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false,
  maxConcurrentInstances: 4, workingDirectories: [], browsableRoots: [], discoveredProjects: [] };

describe('Claude spawn policy worker capability', () => {
  it('survives the registration and heartbeat schemas', () => {
    const capabilities = { ...caps, claudeSpawnPolicy: 1 as const };
    expect(NodeRegisterParamsSchema.parse({ nodeId: '00000000-0000-4000-8000-000000000001', name: 'worker', capabilities }).capabilities)
      .toMatchObject({ claudeSpawnPolicy: 1 });
    expect(NodeHeartbeatParamsSchema.parse({ nodeId: 'worker', activeInstances: 0, capabilities }).capabilities)
      .toMatchObject({ claudeSpawnPolicy: 1 });
  });

  it.each([undefined, '1', 2])('reads a missing or malformed value (%j) as absent without rejecting the heartbeat', (value) => {
    const result = NodeHeartbeatParamsSchema.parse({ nodeId: 'worker', activeInstances: 0, capabilities: { ...caps, claudeSpawnPolicy: value } });
    expect(result.capabilities?.claudeSpawnPolicy).toBeUndefined();
  });
});
