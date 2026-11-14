/**
 * A phone-app member's conversation stays out of the owner's shared memory and learning: nothing she says or the
 * agent replies is ingested into the context systems the owner's own sessions retrieve from.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }),
}));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({ triggerHooks: vi.fn().mockResolvedValue(undefined), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({ classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })) }),
}));

import { InstanceCommunicationManager } from './instance-communication';

function setup() {
  const ingestToRLM = vi.fn();
  const ingestToUnifiedMemory = vi.fn();
  const manager = new InstanceCommunicationManager({
    getInstance: () => undefined, getAdapter: () => undefined, setAdapter: vi.fn(), deleteAdapter: vi.fn(() => true),
    queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM, ingestToUnifiedMemory,
  });
  const message = { id: 'm1', type: 'user', content: 'Plan my week with the long detailed request', timestamp: 1 } as OutputMessage;
  const instance = (metadata?: Record<string, unknown>) => ({
    id: 'i1', sessionId: 's1', outputBuffer: [], contextUsage: { used: 0, total: 1, percentage: 0 }, metadata,
  }) as unknown as Instance;
  return { manager, message, instance, ingestToRLM, ingestToUnifiedMemory };
}

describe('InstanceCommunicationManager memory ingestion', () => {
  it("does not ingest a member's messages", () => {
    const { manager, message, instance, ingestToRLM, ingestToUnifiedMemory } = setup();

    manager.addToOutputBuffer(instance({ mobileProfileId: 'member-1' }), message);

    expect(ingestToRLM).not.toHaveBeenCalled();
    expect(ingestToUnifiedMemory).not.toHaveBeenCalled();
  });

  it("still ingests the owner's messages", () => {
    const { manager, message, instance, ingestToRLM, ingestToUnifiedMemory } = setup();

    manager.addToOutputBuffer(instance(), message);

    expect(ingestToRLM).toHaveBeenCalledWith('i1', message);
    expect(ingestToUnifiedMemory).toHaveBeenCalled();
  });
});
