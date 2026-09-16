import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
import { InstanceCommunicationManager } from './instance-communication';

function setup() {
  const adapter = new EventEmitter() as CliAdapter;
  let currentAdapter = adapter;
  const instance = {
    id: 'mcp-instance', sessionId: 's', status: 'busy', provider: 'claude',
    restartEpoch: 0, parentId: null, agentId: 'build',
  } as Instance;
  const onMcpServersStatus = vi.fn();
  const onStatusSettled = vi.fn();
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => currentAdapter,
    setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate: vi.fn(),
    processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
    onMcpServersStatus, onStatusSettled,
  });
  manager.setupAdapterEvents(instance.id, adapter);
  return {
    adapter, instance, onMcpServersStatus, onStatusSettled,
    replaceAdapter: () => { currentAdapter = new EventEmitter() as CliAdapter; },
  };
}

describe('Harness MCP startup wiring', () => {
  it('forwards the init MCP report with the adapter generation it belongs to', () => {
    const { adapter, instance, onMcpServersStatus } = setup();
    const servers = [{ name: 'browser-gateway', status: 'failed' }];

    adapter.emit('mcp_servers', servers);

    expect(onMcpServersStatus).toHaveBeenCalledExactlyOnceWith(
      'mcp-instance', instance.adapterGeneration, servers,
    );
  });

  it('drops the report from a replaced adapter', () => {
    const { adapter, onMcpServersStatus, replaceAdapter } = setup();
    replaceAdapter();

    adapter.emit('mcp_servers', [{ name: 'browser-gateway', status: 'failed' }]);

    expect(onMcpServersStatus).not.toHaveBeenCalled();
  });

  it('signals a settle when the adapter moves the turn to idle', () => {
    const { adapter, instance, onStatusSettled } = setup();

    adapter.emit('status', 'idle');

    expect(instance.status).toBe('idle');
    expect(onStatusSettled).toHaveBeenCalledWith('mcp-instance');
  });
});
