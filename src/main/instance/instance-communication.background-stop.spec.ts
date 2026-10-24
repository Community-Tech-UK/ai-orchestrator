import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInstanceAsyncWorkRegistry, _resetForTesting } from './instance-async-work-registry';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100 }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'system' }) }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 1 }) }));
import { InstanceCommunicationManager } from './instance-communication';

class ShutdownReportingAdapter extends EventEmitter {
  private reporter: ((message: OutputMessage) => void) | null = null;
  setBackgroundWorkTerminationReporter(reporter: ((message: OutputMessage) => void) | null): void {
    this.reporter = reporter;
  }
  terminate(): void {
    this.reporter?.({
      id: 'shutdown-notice', timestamp: 1, type: 'system',
      content: 'Closing this session also stopped 1 background command (sleep 300).',
      metadata: { backgroundCommandsStopped: 1 },
    });
  }
}

function setup() {
  const adapter = new ShutdownReportingAdapter();
  const instance = {
    id: 'codex-session', sessionId: 'session', status: 'idle', provider: 'codex',
    restartEpoch: 0, parentId: null, agentId: 'build', outputBuffer: [], lastActivity: 1,
  } as unknown as Instance;
  let currentInstance: Instance | undefined = instance;
  let currentAdapter = adapter;
  const onOutput = vi.fn();
  const manager = new InstanceCommunicationManager({
    getInstance: () => currentInstance,
    getAdapter: () => currentAdapter as unknown as CliAdapter,
    setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate: vi.fn(),
    processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), onOutput,
  });
  manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
  const output = vi.fn();
  manager.on('output', output);
  return { manager, adapter, instance, output, onOutput,
    replaceAdapter: () => { currentAdapter = new ShutdownReportingAdapter(); },
    removeInstance: () => { currentInstance = undefined; },
    replaceInstance: () => { currentInstance = { ...instance, outputBuffer: [] }; },
  };
}

describe('background command shutdown transcript', () => {
  afterEach(() => _resetForTesting());
  it('keeps the notice after deliberate teardown detaches adapter listeners', () => {
    const { adapter, instance, output } = setup();
    adapter.emit('async_work', { phase: 'started', workId: 'codex-term:1', kind: 'background-shell' });
    expect(getInstanceAsyncWorkRegistry().hasInhibitor(instance.id)).toBe(true);
    adapter.removeAllListeners();
    instance.restartEpoch! += 1;
    adapter.terminate();
    expect(instance.outputBuffer).toHaveLength(1);
    expect(instance.outputBuffer[0]?.content).toContain('also stopped 1 background command');
    expect(getInstanceAsyncWorkRegistry().hasInhibitor(instance.id)).toBe(false);
    expect(output).toHaveBeenCalledExactlyOnceWith({ instanceId: instance.id, message: instance.outputBuffer[0] });
  });

  it('keeps the notice when a replacement adapter has already been registered for the same session', () => {
    const { adapter, instance, replaceAdapter } = setup();
    replaceAdapter();
    adapter.removeAllListeners();
    adapter.terminate();
    expect(instance.outputBuffer).toHaveLength(1);
  });

  it.each(['remove', 'replace'] as const)('does not append a late shutdown notice after instance %s', (action) => {
    const { adapter, instance, output, removeInstance, replaceInstance } = setup();
    if (action === 'remove') removeInstance(); else replaceInstance();
    adapter.terminate();
    expect(instance.outputBuffer).toEqual([]);
    expect(output).not.toHaveBeenCalled();
  });
  it('does not treat a background-work polling snapshot as command progress', () => {
    const { adapter, instance, onOutput } = setup();
    adapter.emit('async_work', {
      phase: 'snapshot', work: [{ workId: 'codex-term:1', kind: 'background-shell' }],
    });
    expect(instance.lastActivity).toBe(1);
    expect(onOutput).not.toHaveBeenCalled();
    adapter.emit('async_work', { phase: 'progress', workId: 'codex-term:1', kind: 'background-shell' });
    expect(instance.lastActivity).toBeGreaterThan(1);
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('clears predecessor work when binding a replacement runtime', () => {
    const registry = getInstanceAsyncWorkRegistry();
    registry.observe('codex-session', { phase: 'started', workId: 'codex-term:stale', kind: 'background-shell' });
    registry.beginCompletionDelivery('codex-session');
    setup();
    expect(registry.activeWorkIds('codex-session')).toEqual([]);
    expect(registry.hasInhibitor('codex-session')).toBe(false);
  });

});
