import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { createInstance } from '../../shared/types/instance.types';
const reportReasoning = vi.hoisted(() => vi.fn());
vi.mock('../orchestration/orchestration-activity-bridge', () => ({ getOrchestrationActivityBridge: () => ({ reportReasoning }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
import { InstanceCommunicationManager } from './instance-communication';

describe('reasoning progress runtime wiring', () => {
  it('forwards current adapter headlines and ignores events from a replaced generation', () => {
    reportReasoning.mockClear();
    const instance = { ...createInstance({ workingDirectory: '/tmp/project', provider: 'claude' }), id: 'session', adapterGeneration: 0 };
    const emitter = new EventEmitter(); let adapter = emitter as unknown as CliAdapter;
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
      setAdapter: vi.fn(), deleteAdapter: vi.fn(), queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn() });
    manager.setupAdapterEvents('session', adapter);
    emitter.emit('reasoning-headline', 'Checking migrations');
    expect(reportReasoning).toHaveBeenCalledWith('session', 'Checking migrations');
    reportReasoning.mockClear(); instance.adapterGeneration++;
    emitter.emit('reasoning-headline', 'Old generation');
    expect(reportReasoning).not.toHaveBeenCalled();
    adapter = new EventEmitter() as unknown as CliAdapter;
    emitter.emit('reasoning-headline', 'Old adapter'); expect(reportReasoning).not.toHaveBeenCalled();
  });
});
