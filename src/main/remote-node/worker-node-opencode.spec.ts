import { beforeEach, describe, expect, it } from 'vitest';
import { WorkerNodeRegistry } from './worker-node-registry';
import { NodeHeartbeatParamsSchema } from './rpc-schemas';
import { InstanceCreatePayloadSchema, InstanceCreateWithMessagePayloadSchema } from '@contracts/schemas/instance';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';
const caps: WorkerNodeCapabilities = { platform: 'win32', arch: 'x64', cpuCores: 8, totalMemoryMB: 16000, availableMemoryMB: 8000,
  supportedClis: ['opencode'], hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false,
  maxConcurrentInstances: 4, workingDirectories: [], browsableRoots: [], discoveredProjects: [] };
describe('OpenCode worker version capability', () => {
  beforeEach(() => WorkerNodeRegistry._resetForTesting());
  it('preserves the required major through both instance creation contracts', () => {
    const input = { workingDirectory: '/workspace', provider: 'opencode', nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 } };
    expect(InstanceCreatePayloadSchema.parse(input).nodePlacement).toMatchObject({ requiresOpenCodeMajor: 2 });
    expect(InstanceCreateWithMessagePayloadSchema.parse({ ...input, message: 'hello' }).nodePlacement).toMatchObject({ requiresOpenCodeMajor: 2 });
    expect(InstanceCreatePayloadSchema.safeParse({ ...input, nodePlacement: { requiresOpenCodeMajor: 3 } }).success).toBe(false);
  });
  it('preserves the major in heartbeat validation', () => {
    const result = NodeHeartbeatParamsSchema.parse({ nodeId: 'worker', activeInstances: 0, capabilities: { ...caps, openCodeMajor: 2 } });
    expect(result.capabilities).toMatchObject({ openCodeMajor: 2 });
  });
  it('only routes OpenCode 2 requirements to a worker advertising that major', () => {
    const registry = WorkerNodeRegistry.getInstance();
    for (const [id, major] of [['unknown', undefined], ['old', 1], ['current', 2]] as const) registry.registerNode({ id, name: id, status: 'connected', activeInstances: 0, capabilities: { ...caps, ...(major ? { openCodeMajor: major } : {}) } });
    expect(registry.selectNode({ requiresCli: 'opencode', requiresOpenCodeMajor: 2 })?.id).toBe('current');
    registry.deregisterNode('current');
    expect(registry.selectNode({ requiresCli: 'opencode', requiresOpenCodeMajor: 2 })).toBeNull();
  });
});
