import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: vi.fn() }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: vi.fn() }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
import { InstanceCommunicationManager } from './instance-communication';

/**
 * Plan 2026-09-26: an advisory adapter `error` status must not flip an
 * instance that lifecycle is recovering (respawning/interrupting/cancelling)
 * to terminal `error`. That race killed auto-respawn — the error status
 * landed before respawnAfterUnexpectedExit's shouldAbortRespawn check, which
 * treats `error` as terminal ("Skipping auto-respawn because instance is no
 * longer recoverable"). Positive control: from `busy` the status still applies.
 */
describe('adapter error status during recovery', () => {
  function setup(initialStatus: Instance['status']): {
    adapter: CliAdapter;
    instance: Instance;
    queueUpdate: ReturnType<typeof vi.fn>;
  } {
    const adapter = Object.assign(new EventEmitter(), {
      getName: () => 'test-adapter',
    }) as unknown as CliAdapter;
    const instance = {
      id: 'rec-1',
      sessionId: 'rec-session',
      status: initialStatus,
      provider: 'copilot',
      currentModel: 'gpt-6-astra',
      restartEpoch: 0,
      parentId: null,
      agentId: 'build',
    } as Instance;
    const queueUpdate = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance,
      getAdapter: () => adapter,
      setAdapter: vi.fn(),
      deleteAdapter: () => false,
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: vi.fn(),
    });
    manager.setupAdapterEvents('rec-1', adapter);
    return { adapter, instance, queueUpdate };
  }

  it('ignores an advisory error status while the instance is respawning', () => {
    const { adapter, instance, queueUpdate } = setup('respawning');
    adapter.emit('status', 'error');
    expect(instance.status).toBe('respawning');
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('ignores an advisory error status while the instance is interrupting', () => {
    const { adapter, instance, queueUpdate } = setup('interrupting');
    adapter.emit('status', 'error');
    expect(instance.status).toBe('interrupting');
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('still applies an error status from a settled status', () => {
    const { adapter, instance, queueUpdate } = setup('busy');
    adapter.emit('status', 'error');
    expect(instance.status).toBe('error');
    expect(queueUpdate).toHaveBeenCalledWith('rec-1', 'error', undefined);
  });
});
