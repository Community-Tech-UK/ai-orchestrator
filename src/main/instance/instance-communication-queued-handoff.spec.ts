import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../global-pause/global-pause-service', () => ({ globalPauseHoldsAutomaticInput: () => false }));
import { InstanceCommunicationManager } from './instance-communication';

function setup() {
  const adapter = new EventEmitter() as CliAdapter;
  let currentAdapter = adapter;
  const instance = {
    id: 'queued-session', sessionId: 'session', status: 'busy', provider: 'codex',
    restartEpoch: 0, adapterGeneration: 1, parentId: null, agentId: 'build',
  } as Instance;
  const getQueuedInputReadyId = vi.fn<() => string | undefined>(() => 'queued-admission');
  const queueUpdate = vi.fn();
  const transitionState = vi.fn((target: Instance, status: Instance['status']) => { target.status = status; });
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => currentAdapter,
    getQueuedInputReadyId, transitionState,
    setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate,
    processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
  });
  manager.setupAdapterEvents(instance.id, adapter);
  const ready = vi.fn();
  manager.on('queued-input-ready', ready);
  return { adapter, instance, getQueuedInputReadyId, queueUpdate, transitionState, manager, ready,
    replaceAdapter: () => { currentAdapter = new EventEmitter() as CliAdapter; } };
}

describe('Codex queued input handoff', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('retains busy across the queued handoff and publishes only the final idle', () => {
    vi.useFakeTimers();
    const { adapter, instance, ready, transitionState, getQueuedInputReadyId } = setup();
    adapter.emit('status', 'idle');
    adapter.emit('status', 'idle');
    expect(instance.status).toBe('busy');
    expect(ready).toHaveBeenCalledExactlyOnceWith({ instanceId: instance.id, queuedInputReadyId: 'queued-admission', adapterGeneration: instance.adapterGeneration });
    expect(transitionState).not.toHaveBeenCalled();
    adapter.emit('status', 'busy');
    getQueuedInputReadyId.mockReturnValue(undefined);
    adapter.emit('status', 'idle');
    expect(transitionState.mock.calls.filter(([, status]) => status === 'idle')).toHaveLength(1);
    expect(instance.status).toBe('idle');
    vi.advanceTimersByTime(30_000);
    expect(transitionState.mock.calls.filter(([, status]) => status === 'idle')).toHaveLength(1);
  });

  it('settles after a bounded wait when the renderer is absent or refuses delivery', () => {
    vi.useFakeTimers();
    const { adapter, instance, queueUpdate } = setup();
    instance.providerSessionPersisted = false;
    adapter.emit('status', 'idle');
    vi.advanceTimersByTime(29_999);
    expect(instance.status).toBe('busy');
    vi.advanceTimersByTime(1);
    expect(instance.status).toBe('idle');
    expect(instance.providerSessionPersisted).toBe(true);
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'idle', undefined);
  });

  it('keeps the bounded expiry after a late watchdog processing status', () => {
    vi.useFakeTimers();
    const { adapter, instance } = setup();
    adapter.emit('status', 'idle');
    adapter.emit('status', 'processing');
    vi.advanceTimersByTime(30_000);
    expect(instance.status).toBe('idle');
  });

  it('does not settle a replacement adapter when an old offer expires', () => {
    vi.useFakeTimers();
    const { adapter, instance, replaceAdapter, transitionState } = setup();
    adapter.emit('status', 'idle');
    replaceAdapter();
    vi.advanceTimersByTime(30_000);
    expect(instance.status).toBe('busy');
    expect(transitionState).not.toHaveBeenCalled();
  });

  it('keeps interrupt and quota-park settlement outside the handoff', () => {
    const { adapter, instance, ready, getQueuedInputReadyId } = setup();
    instance.status = 'interrupting';
    adapter.emit('status', 'idle');
    instance.status = 'busy';
    instance.waitReason = { kind: 'quota-park' } as Instance['waitReason'];
    adapter.emit('status', 'idle');
    expect(instance.status).toBe('idle');
    expect(ready).not.toHaveBeenCalled();
    expect(getQueuedInputReadyId).not.toHaveBeenCalled();
  });
});
