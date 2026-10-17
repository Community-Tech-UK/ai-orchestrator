import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from '../../shared/types/instance.types';
import { InstanceCommunicationManager } from './instance-communication';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../cli/adapters/acp-cli-adapter.test-helpers';
import { RemoteCliAdapter } from '../cli/adapters/remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';

const registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: { openCodeMajor: 2 } }) });
vi.mock('../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
afterEach(() => { registry.removeAllListeners(); vi.clearAllMocks(); });
function setup(adapter: CliAdapter) {
  const instance = Object.assign(createInstance({ workingDirectory: '/tmp', provider: 'opencode' }), { id: 'catalog-fixture', status: 'idle' as const });
  let current: CliAdapter | undefined = adapter;
  const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => current,
    setAdapter: (_id, value) => { current = value; }, deleteAdapter: () => false, queueUpdate: () => undefined,
    processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
  const updates = vi.fn(); communication.on('commands-changed', updates);
  communication.setupAdapterEvents(instance.id, adapter);
  return { instance, communication, updates, replace: (value: CliAdapter) => { current = value; communication.setupAdapterEvents(instance.id, value); } };
}

describe('actual adapter catalog updates reach instance communication', () => {
  it('publishes initial/changed/empty local catalogs once and drops old epoch/generation events', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' }); adapter.configureOpenCodeV2(true);
    const fixture = setup(adapter);
    try {
      await adapter.spawn();
      const statusBefore = fixture.instance.status;
      const notify = (commands: { name: string; description?: string }[]) => proc.notify('session/update', {
        sessionId: adapter.getSessionId(), update: { sessionUpdate: 'available_commands_update', availableCommands: commands } });
      notify([]); expect(fixture.updates).toHaveBeenCalledTimes(1);
      notify([{ name: 'compact', description: 'Compact' }]);
      notify([{ name: 'compact', description: 'Compact' }]); expect(fixture.updates).toHaveBeenCalledTimes(2);
      notify([{ name: 'compact', description: 'New description' }]);
      notify([{ name: 'new-action', description: 'New action' }]);
      notify([]); expect(fixture.updates).toHaveBeenCalledTimes(5);
      expect(fixture.instance.status).toBe(statusBefore);
      fixture.instance.restartEpoch++;
      notify([{ name: 'old-epoch' }]); expect(fixture.updates).toHaveBeenCalledTimes(5);
      fixture.instance.restartEpoch--;
      fixture.instance.adapterGeneration!++;
      notify([{ name: 'old-generation' }]); expect(fixture.updates).toHaveBeenCalledTimes(5);
    } finally { proc.exit(); fixture.communication.cleanupCircuitBreaker(fixture.instance.id); }
  });
  it('ignores an adapter replaced under the same instance id', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' }); adapter.configureOpenCodeV2(true);
    const fixture = setup(adapter);
    try {
      await adapter.spawn();
      fixture.replace(new EventEmitter() as CliAdapter);
      proc.notify('session/update', { sessionId: adapter.getSessionId(), update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'retired' }] } });
      expect(fixture.updates).not.toHaveBeenCalled();
    } finally { proc.exit(); fixture.communication.cleanupCircuitBreaker(fixture.instance.id); }
  });
  it('handles remote catalogs while preserving the worker incarnation fence', async () => {
    let interactionId = '';
    const sendRpc = vi.fn(async (_node: string, _method: string, payload: { interactionId: string }) => { interactionId = payload.interactionId; return { instanceId: 'remote-fixture' }; });
    const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, 'worker-fixture', 'opencode', { workingDirectory: '/workspace', sessionId: 'remote-fixture' });
    const fixture = setup(adapter);
    try {
      await adapter.spawn();
      const notify = (commands: { name: string; description?: string }[], incarnation = interactionId) => registry.emit('remote:instance-state-change', {
        nodeId: 'worker-fixture', instanceId: 'remote-fixture', state: 'available_commands', info: { interactionId: incarnation, payload: commands } });
      notify([{ name: 'compact', description: 'Compact' }]);
      expect(fixture.updates).toHaveBeenCalledTimes(1);
      notify([{ name: 'compact', description: 'Compact' }]);
      notify([{ name: 'compact', description: 'New description' }]);
      notify([{ name: 'new-action' }]); notify([]);
      expect(fixture.updates).toHaveBeenCalledTimes(4);
      notify([{ name: 'stale-worker' }], 'retired-incarnation');
      expect(adapter.getAvailableCommands()).toEqual([]);
      expect(fixture.updates).toHaveBeenCalledTimes(4);
    } finally { adapter.forceCleanup(); fixture.communication.cleanupCircuitBreaker(fixture.instance.id); }
  });
});
