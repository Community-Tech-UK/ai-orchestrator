import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { ConversationData } from '../../../../shared/types/history.types';
import type { Instance } from '../../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type { PendingSelection } from '../models/compact-model-picker.types';
import { HistoryPreviewSessionService } from './history-preview-session.service';

const first: PendingSelection = { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' };
const second: PendingSelection = { provider: 'claude', model: 'opus', reasoning: 'max' };
const conversation = (id = 'history-1'): ConversationData => ({
  entry: {
    id, displayName: 'Example', workingDirectory: '/tmp/example', createdAt: 1, endedAt: 2,
    messageCount: 0, firstUserMessage: '', lastUserMessage: '', status: 'completed',
    originalInstanceId: 'old', parentId: null, sessionId: 'example-session', provider: 'codex',
  }, messages: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('HistoryPreviewSessionService', () => {
  let service: HistoryPreviewSessionService;
  let runtime: Partial<Instance>;
  const restoreEntry = vi.fn();
  const changeModel = vi.fn();
  const getInstance = vi.fn();
  const setInstanceMessages = vi.fn();
  const setInstanceRestoreMode = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.resetTestingModule();
    runtime = { id: 'real-1', status: 'idle', provider: 'codex', currentModel: 'gpt-6-astra' };
    getInstance.mockImplementation(() => runtime);
    restoreEntry.mockResolvedValue({ success: true, instanceId: 'real-1' });
    changeModel.mockImplementation(async (_id: string, model: string, _reasoning: unknown, target: ModelRuntimeTarget | undefined, provider: Instance['provider']) => ({
      success: true, data: runtime.desiredRuntime ? runtime : { ...runtime, currentModel: model, provider,
        ...(target?.kind === 'local-model' ? { runtimeSummary: { ...target, label: target.modelId } } : {}),
      },
    }));
    TestBed.configureTestingModule({ providers: [
      { provide: HistoryStore, useValue: { restoreEntry } },
      { provide: InstanceStore, useValue: { getInstance, setInstanceMessages, setInstanceRestoreMode } },
      { provide: InstanceIpcService, useValue: { changeModel } },
    ] });
    service = TestBed.inject(HistoryPreviewSessionService);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps independent preview choices without starting runtimes or making live IPC calls', () => {
    service.select('history-1', first);
    service.select('history-2', second);
    expect(service.selection('history-1')).toEqual(first);
    expect(service.selection('history-2')).toEqual(second);
    expect(service.selection('history-3')).toBeNull();
    expect(restoreEntry).not.toHaveBeenCalled();
    expect(changeModel).not.toHaveBeenCalled();
  });

  it('reuses background restore and applies the choice made while it was in flight', async () => {
    const restore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValue(restore.promise);
    const warm = service.restore(conversation());
    const prepared = service.prepare(conversation());
    service.select('history-1', first);
    expect(service.isRestoring('history-1')).toBe(true);
    expect(changeModel).not.toHaveBeenCalled();
    restore.resolve({ success: true, instanceId: 'real-1' });
    expect(await warm).toBe('real-1');
    expect(await prepared).toBe('real-1');
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(changeModel).toHaveBeenCalledWith('real-1', 'gpt-6-astra', 'high', undefined, 'codex');
    expect(service.isRestoring('history-1')).toBe(false);
  });

  it('applies a newer choice made during model switching before returning ready', async () => {
    service.select('history-1', first);
    const apply = deferred<IpcResponse>();
    changeModel.mockReturnValueOnce(apply.promise);
    const prepared = service.prepare(conversation());
    const duplicate = service.prepare(conversation());
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalledOnce());
    service.select('history-1', second);
    apply.resolve({ success: true, data: runtime });
    await expect(prepared).resolves.toBe('real-1');
    await expect(duplicate).resolves.toBe('real-1');
    expect(changeModel).toHaveBeenCalledTimes(2);
    expect(changeModel).toHaveBeenLastCalledWith('real-1', 'opus', 'max', undefined, 'claude');
  });

  it('does not confuse overlapping restores of different history entries', async () => {
    const restoreA = deferred<{ success: boolean; instanceId: string }>();
    const restoreB = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValueOnce(restoreA.promise).mockReturnValueOnce(restoreB.promise);
    const a = service.restore(conversation('a'));
    const b = service.restore(conversation('b'));
    expect(service.restore(conversation('a'))).toBe(a);
    restoreB.resolve({ success: true, instanceId: 'real-b' });
    await b;
    expect(service.isRestoring('a')).toBe(true);
    expect(service.isRestoring('b')).toBe(false);
    restoreA.resolve({ success: true, instanceId: 'real-a' });
    await a;
    expect(service.restoredInstanceId('a')).toBe('real-a');
    expect(service.restoredInstanceId('b')).toBe('real-b');
  });

  it('does not apply a choice during background warmup, including after it finishes', async () => {
    service.select('history-1', first);
    await service.restore(conversation());
    expect(changeModel).not.toHaveBeenCalled();
    await service.prepare(conversation());
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(changeModel).toHaveBeenCalledOnce();
  });

  it('keeps a rejected choice for retry and isolates errors by history entry', async () => {
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: false, error: { message: 'Unavailable' } });
    expect(await service.prepare(conversation())).toBeNull();
    expect(service.error('history-1')).toContain('Unavailable');
    expect(service.error('history-2')).toBeNull();
    expect(service.selection('history-1')).toEqual(first);
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(service.error('history-1')).toBeNull();
    expect(restoreEntry).toHaveBeenCalledOnce();
  });

  it('does not trust cached model confirmation across separate continuations', async () => {
    service.select('history-1', first);
    await service.prepare(conversation());
    changeModel.mockResolvedValueOnce({ success: false, error: { message: 'Runtime changed elsewhere' } });
    expect(await service.prepare(conversation())).toBeNull();
    expect(changeModel).toHaveBeenCalledTimes(2);
  });

  it('waits through a queued acknowledgement and confirms application after readiness', async () => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing', desiredRuntime: { provider: 'codex', model: first.model! } };
    service.select('history-1', first);
    let ready = false;
    const result = service.prepare(conversation()).then(id => { ready = true; return id; });
    await vi.advanceTimersByTimeAsync(500);
    expect(ready).toBe(false);
    expect(changeModel).toHaveBeenCalledOnce();
    runtime = { ...runtime, status: 'idle', desiredRuntime: undefined };
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBe('real-1');
    expect(changeModel).toHaveBeenCalledTimes(2);
  });

  it('returns a retryable failure if a queued change never applies', async () => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing', desiredRuntime: { provider: 'codex', model: first.model! } };
    service.select('history-1', first);
    const result = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeNull();
    expect(service.error('history-1')).toContain('has not been sent');
    expect(service.selection('history-1')).toEqual(first);
  });

  it('rejects a success without a real matching instance confirmation', async () => {
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: true });
    expect(await service.prepare(conversation())).toBeNull();
    expect(service.error('history-1')).toContain('did not confirm');
  });

  it('does not release continuation when the backend confirms a different model', async () => {
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: true, data: { ...runtime, currentModel: 'gpt-5.6-sol' } });
    expect(await service.prepare(conversation())).toBeNull();
    expect(service.error('history-1')).toContain('different model');
    expect(service.selection('history-1')).toEqual(first);
  });

  it('bounds a stalled IPC call and ignores its late confirmation', async () => {
    vi.useFakeTimers();
    service.select('history-1', first);
    const stalled = deferred<IpcResponse>();
    changeModel.mockReturnValueOnce(stalled.promise);
    const result = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeNull();
    expect(service.error('history-1')).toContain('has not been sent');
    stalled.resolve({ success: true, data: runtime });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.selection('history-1')).toEqual(first);
    expect(service.error('history-1')).toContain('has not been sent');
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(restoreEntry).toHaveBeenCalledOnce();
  });

  it('forwards local-model targets and explicit provider-decided reasoning', async () => {
    const target = { kind: 'local-model', source: 'this-device', endpointProvider: 'ollama',
      endpointId: 'ollama', modelId: 'example-model', selectorId: 'lm://this-device/ollama/ollama/example-model' } as const;
    service.select('history-1', { provider: 'local-model', model: target.selectorId, reasoning: null, modelRuntimeTarget: target });
    await service.prepare(conversation());
    expect(changeModel).toHaveBeenCalledWith('real-1', 'example-model', null, target, undefined);
  });

  it('retains newer draft choices when completing a previous continuation', async () => {
    service.select('history-1', first);
    await service.prepare(conversation());
    service.select('history-1', second);
    service.complete('history-1');
    expect(service.selection('history-1')).toEqual(second);
    await service.prepare(conversation());
    service.complete('history-1');
    expect(service.selection('history-1')).toBeNull();
  });
});
