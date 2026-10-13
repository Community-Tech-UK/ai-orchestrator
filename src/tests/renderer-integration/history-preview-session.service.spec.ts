import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../../renderer/app/core/state/history.store';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { InstanceIpcService } from '../../renderer/app/core/services/ipc/instance-ipc.service';
import { ProviderAccountIpcService } from '../../renderer/app/core/services/ipc/provider-account-ipc.service';
import type { IpcResponse } from '../../renderer/app/core/services/ipc/electron-ipc.service';
import type { ConversationData } from '../../shared/types/history.types';
import type { Instance } from '../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import type { PendingSelection } from '../../renderer/app/features/models/compact-model-picker.types';
import { HistoryPreviewSessionService } from '../../renderer/app/features/instance-detail/history-preview-session.service';
import { DesiredRuntimeQueue } from '../../main/instance/lifecycle/desired-runtime-queue';
import { SessionRevivalService } from '../../main/session/session-revival-service';

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
  const terminateInstance = vi.fn();
  const switchSession = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.resetTestingModule();
    runtime = { id: 'real-1', status: 'idle', provider: 'codex', currentModel: 'gpt-6-astra' };
    getInstance.mockImplementation(() => runtime);
    restoreEntry.mockImplementation(async (_entryId: string, _directory: string, accountProfileId?: string) => {
      if (accountProfileId) runtime = { ...runtime, accountProfileId };
      return { success: true, instanceId: 'real-1' };
    });
    changeModel.mockImplementation(async (_id: string, model: string, _reasoning: unknown, target: ModelRuntimeTarget | undefined, provider: Instance['provider']) => ({
      success: true, data: runtime.desiredRuntime ? runtime : { ...runtime, currentModel: model, provider,
        ...(target?.kind === 'local-model' ? { runtimeSummary: { ...target, label: target.modelId } } : {}),
      },
    }));
    terminateInstance.mockResolvedValue(undefined);
    switchSession.mockImplementation(async (_id: string, accountProfileId: string) => {
      runtime = { ...runtime, accountProfileId };
      return { success: true };
    });
    TestBed.configureTestingModule({ providers: [
      { provide: HistoryStore, useValue: { restoreEntry } },
      { provide: InstanceStore, useValue: { getInstance, setInstanceMessages, setInstanceRestoreMode, terminateInstance } },
      { provide: InstanceIpcService, useValue: { changeModel } },
      { provide: ProviderAccountIpcService, useValue: { switchSession } },
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

  it('restores onto the account chosen for the same provider', async () => {
    service.chooseAccount('history-1', 'codexcomtech-1');
    await service.prepare(conversation());
    expect(restoreEntry).toHaveBeenCalledWith('history-1', '/tmp/example', 'codexcomtech-1');
    expect(switchSession).not.toHaveBeenCalled();
    service.complete('history-1');
    expect(service.accountChoice('history-1')).toBeNull();
  });

  it('hands off the same warm instance without losing its selected model or terminating it', async () => {
    await service.restore(conversation());
    expect(restoreEntry).toHaveBeenCalledWith('history-1', '/tmp/example');
    service.chooseAccount('history-1', 'codexsuas-1');
    service.select('history-1', first);
    changeModel.mockImplementation(async (_id, currentModel) => {
      runtime = { ...runtime, currentModel };
      return { success: true, data: runtime };
    });
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(terminateInstance).not.toHaveBeenCalled();
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledWith('real-1', 'codexsuas-1');
    expect(runtime.currentModel).toBe(first.model);
  });

  it.each([
    ['during restore', 'example-original'],
    ['after warm restore', 'example-original'],
    ['during restore', undefined],
    ['after warm restore', undefined],
  ] as const)('resets a spawn-pinned choice cleared %s to archived account %s', async (when, original) => {
    const archived = conversation();
    archived.entry.accountProfileId = original;
    service.chooseAccount('history-1', 'example-selected');
    const pending = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockImplementationOnce((_entryId, _directory, accountProfileId) => {
      runtime = { ...runtime, accountProfileId };
      return pending.promise;
    });
    const warm = service.restore(archived);
    if (when === 'during restore') service.clearAccountChoice('history-1');
    pending.resolve({ success: true, instanceId: 'real-1' });
    await warm;
    if (when === 'after warm restore') service.clearAccountChoice('history-1');
    expect(await service.prepare(archived)).toBe('real-1');
    expect(runtime.accountProfileId).toBe(original ?? 'legacy');
    expect(switchSession).toHaveBeenCalledWith('real-1', original ?? 'legacy');
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('does not reset a cleared spawn override onto a newly selected provider', async () => {
    const archived = conversation();
    archived.entry.accountProfileId = 'example-codex-original';
    service.chooseAccount('history-1', 'example-codex-selected');
    await service.restore(archived);
    service.clearAccountChoice('history-1');
    service.select('history-1', second);
    changeModel.mockImplementation(async () => {
      runtime = { ...runtime, provider: 'claude', currentModel: second.model!, accountProfileId: 'example-claude-default' };
      return { success: true, data: runtime };
    });
    expect(await service.prepare(archived)).toBe('real-1');
    expect(runtime.accountProfileId).toBe('example-claude-default');
    expect(switchSession).not.toHaveBeenCalled();
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it.each(['initial restore', 'later handoff'])('uses a confirmed provider swap before store events after %s', async when => {
    const archived = conversation();
    archived.entry.accountProfileId = 'example-codex-original';
    runtime = { ...runtime, accountProfileId: archived.entry.accountProfileId };
    if (when === 'initial restore') service.chooseAccount('history-1', 'example-codex-selected');
    await service.restore(archived);
    if (when === 'later handoff') {
      service.chooseAccount('history-1', 'example-codex-selected');
      await service.prepare(archived);
      switchSession.mockClear();
    }
    service.clearAccountChoice('history-1');
    service.select('history-1', second);
    changeModel.mockResolvedValueOnce({ success: true, data: {
      ...runtime, provider: 'claude', currentModel: second.model!, accountProfileId: 'example-claude-default',
    } });
    switchSession.mockResolvedValueOnce({ success: false, error: { message: 'Unexpected old-provider account' } });
    expect(await service.prepare(archived)).toBe('real-1');
    expect(runtime.provider).toBe('codex');
    expect(switchSession).not.toHaveBeenCalled();
    expect(service.confirmedSelectionForInstance('real-1', 'codex', runtime.currentModel)).toEqual(second);
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('applies an account chosen for a different provider after the swap', async () => {
    service.select('history-1', second);
    service.chooseAccount('history-1', 'max-b-1a2b');
    switchSession.mockImplementation(async () => {
      runtime = { ...runtime, provider: 'claude', currentModel: 'opus', accountProfileId: 'max-b-1a2b' };
      return { success: true };
    });
    await service.prepare(conversation());
    expect(restoreEntry).toHaveBeenCalledWith('history-1', '/tmp/example');
    expect(changeModel).toHaveBeenCalledWith('real-1', 'opus', 'max', undefined, 'claude');
    expect(switchSession).toHaveBeenCalledWith('real-1', 'max-b-1a2b');
  });

  it('waits for actual readiness after the chosen account is stamped during startup', async () => {
    vi.useFakeTimers();
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    switchSession.mockImplementation(async () => {
      runtime = { ...runtime, accountProfileId: 'example-selected', status: 'initializing', desiredRuntime: undefined };
      return { success: true };
    });
    let ready = false;
    const result = service.prepare(conversation()).then(id => { ready = true; return id; });
    await vi.advanceTimersByTimeAsync(500);
    expect(ready).toBe(false);
    runtime = { ...runtime, status: 'idle' };
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toBe('real-1');
  });

  it('confirms the spawned account instead of trusting the requested restore override', async () => {
    restoreEntry.mockResolvedValue({ success: true, instanceId: 'real-1' });
    runtime = { ...runtime, accountProfileId: 'example-other' };
    service.chooseAccount('history-1', 'example-selected');
    switchSession.mockResolvedValue({ success: false, error: { message: 'Account unavailable' } });
    expect(await service.prepare(conversation())).toBeNull();
    expect(switchSession).toHaveBeenCalledWith('real-1', 'example-selected');
    expect(service.error('history-1')).toContain('Account unavailable');
    expect(service.accountChoice('history-1')).toBe('example-selected');
  });

  it('preserves a newer account-only draft when the previous continuation completes', async () => {
    service.chooseAccount('history-1', 'example-first');
    await service.prepare(conversation());
    service.chooseAccount('history-1', 'example-newer');
    service.complete('history-1');
    expect(service.accountChoice('history-1')).toBe('example-newer');
    expect(await service.prepare(conversation())).toBe('real-1');
    service.complete('history-1');
    expect(service.accountChoice('history-1')).toBeNull();
  });

  it('applies a newer account picked during an existing handoff before releasing continuation', async () => {
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-first');
    const firstSwitch = deferred<IpcResponse>();
    switchSession.mockReturnValueOnce(firstSwitch.promise);
    const result = service.prepare(conversation());
    await vi.waitFor(() => expect(switchSession).toHaveBeenCalledOnce());
    service.chooseAccount('history-1', 'example-newer');
    runtime = { ...runtime, accountProfileId: 'example-first' };
    firstSwitch.resolve({ success: true });
    expect(await result).toBe('real-1');
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-newer');
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('keeps the draft if account startup fails despite a matching account stamp, then retries', async () => {
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    switchSession.mockImplementationOnce(async () => {
      runtime = { ...runtime, accountProfileId: 'example-selected', status: 'error' };
      return { success: true };
    });
    expect(await service.prepare(conversation())).toBeNull();
    expect(service.error('history-1')).toContain('stopped');
    expect(service.accountChoice('history-1')).toBe('example-selected');
    runtime = { ...runtime, status: 'idle' };
    expect(await service.prepare(conversation())).toBe('real-1');
  });

  it('bounds a stalled restore without losing ownership of its late result', async () => {
    vi.useFakeTimers();
    const restore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValue(restore.promise);
    service.select('history-1', first);
    const result = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeNull();
    expect(service.error('history-1')).toContain('has not been sent');
    expect(service.selection('history-1')).toEqual(first);
    expect(service.isRestoring('history-1')).toBe(true);
    restore.resolve({ success: true, instanceId: 'real-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(restoreEntry).toHaveBeenCalledOnce();
  });

  it('returns to the original account when an override clears after failed account startup', async () => {
    runtime = { ...runtime, accountProfileId: 'example-original' };
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    switchSession.mockImplementationOnce(async (_id, accountProfileId) => {
      runtime = { ...runtime, accountProfileId, status: 'error' };
      return { success: true };
    });
    expect(await service.prepare(conversation())).toBeNull();
    service.clearAccountChoice('history-1');
    runtime = { ...runtime, status: 'idle' };
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-original');
    expect(runtime.accountProfileId).toBe('example-original');
  });

  it('bounds a stalled account IPC and keeps the choice for retry', async () => {
    vi.useFakeTimers();
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    const stalled = deferred<IpcResponse>();
    switchSession.mockReturnValueOnce(stalled.promise);
    const result = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeNull();
    expect(service.accountChoice('history-1')).toBe('example-selected');
    stalled.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.prepare(conversation())).toBe('real-1');
  });

  it('keeps ownership of a timed-out account write before resetting a matching stale account', async () => {
    vi.useFakeTimers();
    runtime = { ...runtime, accountProfileId: 'example-original' };
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    const stalled = deferred<IpcResponse>();
    switchSession.mockReturnValueOnce(stalled.promise);
    const firstAttempt = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await firstAttempt).toBeNull();
    service.clearAccountChoice('history-1');
    let released = false;
    const retry = service.prepare(conversation()).then(id => { released = id !== null; return id; });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    expect(switchSession).toHaveBeenCalledOnce();
    // Backend completion can precede its account state event. The store still
    // shows the original account, but resetting must supersede the finished write.
    stalled.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await retry).toBe('real-1');
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-original');
    expect(switchSession).toHaveBeenCalledTimes(2);
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('does not apply a new model while an earlier timed-out account write is pending', async () => {
    vi.useFakeTimers();
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    const stalled = deferred<IpcResponse>();
    switchSession.mockReturnValueOnce(stalled.promise);
    const firstAttempt = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await firstAttempt).toBeNull();
    service.clearAccountChoice('history-1');
    service.select('history-1', second);
    const retry = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(0);
    expect(changeModel).not.toHaveBeenCalled();
    stalled.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await retry).toBe('real-1');
    expect(changeModel).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledOnce();
  });

  it('waits for a real queued account apply to finish before resetting', async () => {
    vi.useFakeTimers();
    runtime = { ...runtime, accountProfileId: 'example-original' };
    await service.restore(conversation());
    const main = { ...runtime, status: 'busy' } as Instance;
    const heldApply = deferred<void>();
    const applyChange = vi.fn(async (_id: string, desired: NonNullable<Instance['desiredRuntime']>) => {
      if (desired.accountProfileId === 'example-selected') await heldApply.promise;
      main.accountProfileId = desired.accountProfileId;
      runtime = { ...runtime, accountProfileId: main.accountProfileId, status: 'idle', desiredRuntime: undefined };
      return main;
    });
    const queue = new DesiredRuntimeQueue({
      getInstance: () => main,
      isAdapterOnLoan: () => false,
      applyChange,
      publishPendingState: () => {
        runtime = { ...runtime, status: main.status, accountProfileId: main.accountProfileId, desiredRuntime: main.desiredRuntime };
      },
      notifyApplyFailure: vi.fn(),
    });
    switchSession.mockImplementation(async (_id: string, accountProfileId: string) => {
      await queue.requestChange(main.id, { provider: 'codex', accountProfileId,
        accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
      return { success: true };
    });
    service.chooseAccount('history-1', 'example-selected');
    const firstAttempt = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await firstAttempt).toBeNull();
    expect(main.desiredRuntime?.accountProfileId).toBe('example-selected');
    main.status = 'idle';
    queue.onSettled(main);
    await vi.advanceTimersByTimeAsync(0);
    expect(applyChange).toHaveBeenCalledOnce();
    expect(runtime).toMatchObject({ status: 'idle', accountProfileId: 'example-original' });
    expect(runtime.desiredRuntime?.accountProfileId).toBe('example-selected');
    service.clearAccountChoice('history-1');
    let released = false;
    const retry = service.prepare(conversation()).then(id => { released = id !== null; return id; });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    expect(switchSession).toHaveBeenCalledOnce();
    heldApply.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(await retry).toBe('real-1');
    expect(runtime.accountProfileId).toBe('example-original');
    expect(applyChange).toHaveBeenCalledTimes(2);
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-original');
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it.each([
    ['immediate', true], ['queued', true], ['immediate', false], ['queued', false],
  ] as const)('keeps a reconnected preview behind an existing %s account write with an override: %s', async (when, override) => {
    vi.useFakeTimers();
    const archived = conversation('example-session');
    archived.entry.historyThreadId = 'example-thread';
    runtime = { ...runtime, accountProfileId: 'example-original' };
    const main = { ...runtime, status: when === 'queued' ? 'busy' : 'idle',
      historyThreadId: archived.entry.historyThreadId, sessionId: archived.entry.sessionId } as Instance;
    const heldApply = deferred<void>();
    const applyChange = vi.fn(async (_id: string, desired: NonNullable<Instance['desiredRuntime']>) => {
      if (desired.accountProfileId === 'example-selected') await heldApply.promise;
      main.accountProfileId = desired.accountProfileId;
      runtime = { ...main };
      return main;
    });
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    const previous = queue.requestChange(main.id, { provider: 'codex', accountProfileId: 'example-selected',
      accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
    if (when === 'queued') { main.status = 'idle'; queue.onSettled(main); }
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.accountProfileId).toBe('example-original');
    expect(runtime.desiredRuntime?.accountProfileId).toBe('example-selected');
    const heavyRestore = vi.fn();
    const manager = { getInstance: () => main, getAllInstances: () => [main] };
    const backend = new SessionRevivalService(manager as unknown as ConstructorParameters<typeof SessionRevivalService>[0],
      { historyRestore: { restore: heavyRestore }, history: { getEntries: () => [archived.entry] } });
    restoreEntry.mockImplementation(async (historyEntryId: string, _directory: string, accountProfileId: string) => {
      const result = await backend.revive({ historyEntryId, accountProfileId,
        reviveIfArchived: true, reason: 'history-restore' });
      return { success: result.status !== 'failed', instanceId: result.instanceId };
    });
    switchSession.mockImplementation(async (_id: string, accountProfileId: string) => {
      await queue.requestChange(main.id, { provider: 'codex', accountProfileId,
        accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
      return { success: true };
    });
    // This service has no knowledge of the earlier renderer's account request.
    if (override) service.chooseAccount(archived.entry.id, 'example-original');
    let released = false;
    const retry = service.prepare(archived).then(id => { released = id !== null; return id; });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    if (override) expect(switchSession).toHaveBeenCalledWith('real-1', 'example-original');
    else expect(switchSession).not.toHaveBeenCalled();
    expect(runtime.desiredRuntime?.accountProfileId).toBe(override ? 'example-original' : 'example-selected');
    expect(heavyRestore).not.toHaveBeenCalled();
    heldApply.resolve();
    await previous;
    await vi.advanceTimersByTimeAsync(250);
    expect(await retry).toBe('real-1');
    expect(runtime.accountProfileId).toBe(override ? 'example-original' : 'example-selected');
    expect(runtime.desiredRuntime).toBeUndefined();
    expect(applyChange).toHaveBeenCalledTimes(override ? 2 : 1);
    expect(restoreEntry).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'failure'] as const)('keeps a no-draft continuation unsent after an existing change reports %s', async outcome => {
    vi.useFakeTimers();
    runtime = { ...runtime, desiredRuntime: { provider: 'codex', accountProfileId: 'example-selected' } };
    const result = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
    else {
      runtime = { ...runtime, status: 'error', desiredRuntime: undefined };
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(await result).toBeNull();
    expect(service.error('history-1')).toContain(outcome === 'timeout' ? 'has not been sent' : 'pending runtime change failed');
    expect(switchSession).not.toHaveBeenCalled();
    runtime = { ...runtime, status: 'idle', desiredRuntime: undefined };
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(restoreEntry).toHaveBeenCalledOnce();
  });

  it('bounds waiting for an older account write and retains the latest draft for retry', async () => {
    vi.useFakeTimers();
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    const stalled = deferred<IpcResponse>();
    switchSession.mockReturnValueOnce(stalled.promise);
    const firstAttempt = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await firstAttempt).toBeNull();
    service.chooseAccount('history-1', 'example-newer');
    const retry = service.prepare(conversation());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await retry).toBeNull();
    expect(service.accountChoice('history-1')).toBe('example-newer');
    expect(switchSession).toHaveBeenCalledOnce();
    stalled.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-newer');
  });

  it('recognizes an unstamped legacy runtime as the legacy account', async () => {
    restoreEntry.mockResolvedValue({ success: true, instanceId: 'real-1' });
    service.chooseAccount('history-1', 'legacy');
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('resets a cleared override to the actual original warm account, not an assumed legacy account', async () => {
    runtime = { ...runtime, accountProfileId: 'example-routed-original' };
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-selected');
    await service.prepare(conversation());
    service.clearAccountChoice('history-1');
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).toHaveBeenLastCalledWith('real-1', 'example-routed-original');
  });

  it('does not apply an old provider account choice after a new provider is selected', async () => {
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-codex');
    service.select('history-1', second);
    changeModel.mockImplementation(async () => {
      runtime = { ...runtime, provider: 'claude', currentModel: second.model!, accountProfileId: 'example-claude-default' };
      return { success: true, data: runtime };
    });
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).not.toHaveBeenCalled();
    expect(runtime.accountProfileId).toBe('example-claude-default');
  });

  it('does not reuse the original provider account when a stale choice clears after a provider swap', async () => {
    runtime = { ...runtime, accountProfileId: 'example-codex-original' };
    await service.restore(conversation());
    service.chooseAccount('history-1', 'example-codex-selected');
    await service.prepare(conversation());
    switchSession.mockClear();
    service.select('history-1', second);
    service.clearAccountChoice('history-1');
    changeModel.mockImplementation(async () => {
      runtime = { ...runtime, provider: 'claude', currentModel: second.model!, accountProfileId: 'example-claude-default' };
      return { success: true, data: runtime };
    });
    expect(await service.prepare(conversation())).toBe('real-1');
    expect(switchSession).not.toHaveBeenCalled();
    expect(runtime.accountProfileId).toBe('example-claude-default');
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

  it('makes the confirmed model available after the preview selection is completed', async () => {
    runtime = { ...runtime, currentModel: 'gpt-5.6-sol' };
    service.select('history-1', first);
    expect(await service.prepare(conversation())).toBe('real-1');
    service.complete('history-1');

    expect(service.selection('history-1')).toBeNull();
    expect(service.confirmedSelectionForInstance('real-1', 'codex', 'gpt-5.6-sol')).toEqual(first);
    expect(service.confirmedSelectionForInstance('real-1', 'codex', 'gpt-6-astra')).toEqual(first);
    expect(service.confirmedSelectionForInstance('real-1', 'codex', 'gpt-6-other')).toBeNull();
    expect(service.confirmedSelectionForInstance('real-1', 'codex', 'gpt-5.6-sol')).toBeNull();
  });

  async function settleReadinessTest(result: Promise<unknown>): Promise<void> {
    runtime = { ...runtime, status: 'terminated' };
    getInstance.mockImplementation(() => runtime);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.allSettled([result]);
  }

  it('holds a no-draft continuation when real revival reuses an initializing runtime without a pending change', async () => {
    vi.useFakeTimers();
    const archived = conversation('example-session');
    const startup = deferred<void>();
    const main = { ...runtime, status: 'initializing', sessionId: archived.entry.sessionId,
      readyPromise: startup.promise } as Instance;
    runtime = main;
    const heavyRestore = vi.fn();
    const backend = new SessionRevivalService({ getInstance: () => main, getAllInstances: () => [main] } as never,
      { historyRestore: { restore: heavyRestore }, history: { getEntries: () => [archived.entry] } });
    restoreEntry.mockImplementation(async historyEntryId => {
      const revived = await backend.revive({ historyEntryId, reviveIfArchived: true, reason: 'history-restore' });
      return { success: revived.status === 'live', instanceId: revived.instanceId };
    });
    let complete = false;
    const preparation = service.prepare(archived);
    const result = preparation.then(id => { complete = true; return id; });
    try {
      expect(service.prepare(archived)).toBe(preparation);
      await vi.advanceTimersByTimeAsync(500);
      expect(complete).toBe(false);
      expect(runtime.desiredRuntime).toBeUndefined();
      expect(heavyRestore).not.toHaveBeenCalled();
      expect(changeModel).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
      main.status = 'ready'; startup.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(complete).toBe(true);
      expect(await result).toBe(main.id);
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      startup.resolve();
      await settleReadinessTest(result);
    }
  });

  it.each(['error', 'failed', 'terminated', 'cancelled', 'superseded', 'missing'] as const)(
    'rejects no-draft startup that becomes %s', async outcome => {
      vi.useFakeTimers();
      runtime = { ...runtime, status: 'initializing' };
      let complete = false;
      const result = service.prepare(conversation()).then(id => { complete = true; return id; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(complete).toBe(false);
        if (outcome === 'missing') getInstance.mockReturnValue(undefined);
        else runtime = { ...runtime, status: outcome };
        await vi.advanceTimersByTimeAsync(250);
        expect(complete).toBe(true);
        expect(await result).toBeNull();
        expect(service.error('history-1')).toContain(outcome === 'error' ? 'did not finish starting' : 'stopped');
        expect(changeModel).not.toHaveBeenCalled();
        expect(switchSession).not.toHaveBeenCalled();
        if (outcome === 'error') {
          runtime = { ...runtime, status: 'idle' };
          expect(await service.prepare(conversation())).toBe('real-1');
        }
        expect(restoreEntry).toHaveBeenCalledOnce();
      } finally { await settleReadinessTest(result); }
    },
  );

  it('uses only the original preparation deadline remaining after a slow restore, then retries the same runtime', async () => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing' };
    const heldRestore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValueOnce(heldRestore.promise);
    let complete = false;
    const result = service.prepare(conversation()).then(id => { complete = true; return id; });
    try {
      await vi.advanceTimersByTimeAsync(29_900);
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(complete).toBe(true);
      expect(await result).toBeNull();
      expect(service.error('history-1')).toContain('has not been sent');
      runtime = { ...runtime, status: 'idle' };
      expect(await service.prepare(conversation())).toBe('real-1');
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await settleReadinessTest(result);
    }
  });

  it.each(['model', 'account'] as const)('re-reads a newer %s draft during no-draft startup before release', async kind => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing' };
    let complete = false;
    const result = service.prepare(conversation()).then(id => { complete = true; return id; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toBe(false);
      if (kind === 'model') service.select('history-1', second);
      else service.chooseAccount('history-1', 'example-recovery');
      await vi.advanceTimersByTimeAsync(250);
      expect(complete).toBe(false);
      runtime = { ...runtime, status: 'idle' };
      await vi.advanceTimersByTimeAsync(250);
      expect(complete).toBe(true);
      expect(await result).toBe('real-1');
      if (kind === 'model') {
        expect(changeModel).toHaveBeenLastCalledWith('real-1', 'opus', 'max', undefined, 'claude');
        expect(service.selection('history-1')).toBe(second);
      } else {
        expect(switchSession).toHaveBeenCalledWith('real-1', 'example-recovery');
        expect(runtime.accountProfileId).toBe('example-recovery');
        expect(service.accountChoice('history-1')).toBe('example-recovery');
      }
    } finally { await settleReadinessTest(result); }
  });

  it.each(['ready-event', 'deadline'] as const)('holds a successful recovered-model confirmation behind a stale error store until %s', async outcome => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'error' };
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: true, data: { ...runtime, status: 'idle' } });
    let complete = false;
    const result = service.prepare(conversation()).then(id => { complete = true; return id; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toBe(false);
      if (outcome === 'ready-event') {
        runtime = { ...runtime, status: 'idle' };
        await vi.advanceTimersByTimeAsync(250);
        expect(complete).toBe(true);
        expect(await result).toBe('real-1');
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(complete).toBe(true);
        expect(await result).toBeNull();
        expect(service.error('history-1')).toContain('has not been sent');
        expect(service.selection('history-1')).toBe(first);
        runtime = { ...runtime, status: 'idle' };
        expect(await service.prepare(conversation())).toBe('real-1');
      }
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally { await settleReadinessTest(result); }
  });

  it.each(['error', 'initializing'] as const)('does not accept a model response in %s despite stale idle store state', async status => {
    vi.useFakeTimers();
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: true, data: { ...runtime, status } });
    let complete = false;
    const result = service.prepare(conversation()).then(id => { complete = true; return id; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (status === 'error') {
        expect(complete).toBe(true);
        expect(await result).toBeNull();
        expect(service.selection('history-1')).toBe(first);
        expect(service.error('history-1')).toContain('selected model did not finish starting');
      } else {
        expect(complete).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        expect(complete).toBe(true);
        expect(await result).toBe('real-1');
        expect(changeModel).toHaveBeenCalledTimes(2);
      }
    } finally { await settleReadinessTest(result); }
  });

  it.each(['model', 'account'] as const)('restarts readiness for a newer %s recovery draft while the prior successful model event is stale', async kind => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'error' };
    service.select('history-1', first);
    changeModel.mockResolvedValueOnce({ success: true, data: { ...runtime, status: 'idle' } });
    let complete = false;
    const result = service.prepare(conversation()).then(id => { complete = true; return id; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(changeModel).toHaveBeenCalledOnce();
      expect(complete).toBe(false);
      if (kind === 'model') {
        service.select('history-1', second);
        changeModel.mockImplementation(async () => {
          runtime = { ...runtime, provider: 'claude', currentModel: second.model!, status: 'idle' };
          return { success: true, data: runtime };
        });
      } else {
        service.chooseAccount('history-1', 'example-recovery');
        switchSession.mockImplementation(async (_id, accountProfileId) => {
          runtime = { ...runtime, accountProfileId, status: 'idle' };
          return { success: true };
        });
      }
      await vi.advanceTimersByTimeAsync(250);
      expect(complete).toBe(true);
      if (kind === 'model') expect(changeModel).toHaveBeenCalledTimes(2);
      else expect(switchSession).toHaveBeenCalledWith('real-1', 'example-recovery');
      expect(await result).toBe('real-1');
    } finally { await settleReadinessTest(result); }
  });
  it.each([
    ['model', 'starting'], ['account', 'starting'], ['model', 'ready'], ['account', 'ready'],
  ] as const)('uses the remaining 100ms after a slow restore for a %s continuation that is %s', async (kind, state) => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: state === 'starting' ? 'initializing' : 'idle' };
    const heldRestore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValueOnce(heldRestore.promise);
    if (kind === 'model') service.select('history-1', first);
    else service.chooseAccount('history-1', 'example-budget-account');
    let settled = false;
    const action = service.prepare(conversation()).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(29_900);
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(state === 'ready');
      if (state === 'starting') {
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(true);
        expect(await action).toBeNull();
        expect(service.error('history-1')).toContain('starting');
        if (kind === 'model') expect(service.selection('history-1')).toBe(first);
        else expect(service.accountChoice('history-1')).toBe('example-budget-account');
        runtime = { ...runtime, status: 'idle' };
        expect(await service.prepare(conversation())).toBe('real-1');
      } else expect(await action).toBe('real-1');
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await settleReadinessTest(action);
    }
  });

  it.each(['model', 'account'] as const)('keeps a %s continuation refused when startup becomes ready after the shared deadline', async kind => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing' };
    const heldRestore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValueOnce(heldRestore.promise);
    if (kind === 'model') service.select('history-1', first);
    else service.chooseAccount('history-1', 'example-budget-account');
    let settled = false;
    const action = service.prepare(conversation()).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(29_900);
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      runtime = { ...runtime, status: 'idle' };
      await vi.advanceTimersByTimeAsync(50);
      expect(await action).toBeNull();
      if (kind === 'model') expect(service.selection('history-1')).toBe(first);
      else expect(service.accountChoice('history-1')).toBe('example-budget-account');
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await settleReadinessTest(action);
    }
  });

  it.each(['model', 'account'] as const)('refuses a late successful %s IPC even when its result wins the deadline timer race', async kind => {
    vi.useFakeTimers();
    const heldRestore = deferred<{ success: boolean; instanceId: string }>();
    restoreEntry.mockReturnValueOnce(heldRestore.promise);
    if (kind === 'model') {
      service.select('history-1', first);
      changeModel.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 101);
        return { success: true, data: runtime };
      });
    } else {
      service.chooseAccount('history-1', 'example-budget-account');
      switchSession.mockImplementationOnce(async (_id, accountProfileId) => {
        vi.setSystemTime(Date.now() + 101);
        runtime = { ...runtime, accountProfileId };
        return { success: true };
      });
    }
    let settled = false;
    const action = service.prepare(conversation()).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(29_900);
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await action).toBeNull();
      expect(service.error('history-1')).toContain('has not been sent');
      if (kind === 'model') expect(service.selection('history-1')).toBe(first);
      else expect(service.accountChoice('history-1')).toBe('example-budget-account');
      expect(await service.prepare(conversation())).toBe('real-1');
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      heldRestore.resolve({ success: true, instanceId: 'real-1' });
      await settleReadinessTest(action);
    }
  });

  it.each(['error', 'idle'] as const)('applies the latest provider recovery choice after an unchanged model starts as %s', async status => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: 'initializing', reasoningEffort: 'high' };
    const main = { ...runtime } as Instance;
    const applied: string[] = [];
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange: async (_id, desired) => {
        applied.push(desired.model!);
        main.provider = desired.provider!;
        main.currentModel = desired.model;
        main.reasoningEffort = desired.reasoningEffort ?? undefined;
        main.status = 'idle';
        runtime = { ...main };
        return main;
      }, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    changeModel.mockImplementation(async (_id, model, reasoningEffort, _target, provider) => {
      try {
        const result = await queue.requestChange(main.id, { model, provider, reasoningEffort });
        return { success: true, data: { ...result } };
      } catch (error) { return { success: false, error: { message: String(error) } }; }
    });
    service.select('history-1', first);
    const prepared = service.prepare(conversation());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(changeModel).toHaveBeenCalledOnce();
      expect(runtime.status).toBe('initializing');
      expect(runtime.desiredRuntime).toBeUndefined();
      service.select('history-1', second);
      main.status = status; runtime = { ...main };
      await vi.advanceTimersByTimeAsync(250);
      const result = await prepared;
      expect(service.selection('history-1')).toEqual(second);
      expect(result).toBe('real-1');
      expect(changeModel).toHaveBeenLastCalledWith('real-1', second.model, second.reasoning, undefined, second.provider);
      expect(applied).toEqual([second.model]);
    } finally {
      main.status = 'terminated'; runtime = { ...main }; queue.onSettled(main);
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled([prepared]); TestBed.resetTestingModule();
    }
  });
  it.each(['same-provider', 'model-default', 'terminal', 'queued-newer', 'held-old-success', 'held-old-failure', 'account-recovery', 'account-model-reject'] as const)(
    're-reads a draft interrupted during model readiness: %s', async kind => {
    vi.useFakeTimers();
    runtime = { ...runtime, status: kind.startsWith('held') ? 'idle' : 'initializing', reasoningEffort: 'high',
      ...(kind.startsWith('held') || kind === 'queued-newer' ? { currentModel: 'example-original' } : {}) };
    const main = { ...runtime } as Instance;
    const applied: string[] = [];
    const held = deferred<void>();
    const heldLatest = deferred<void>();
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange: async (_id, desired) => {
        applied.push(desired.model ?? 'default');
        if (kind === 'queued-newer' && desired.provider === 'claude') await heldLatest.promise;
        if (desired.provider === 'codex' && kind.startsWith('held')) {
          main.status = 'initializing'; runtime = { ...main }; await held.promise;
          if (kind === 'held-old-failure') { main.status = 'error'; runtime = { ...main }; throw new Error('Example old startup failure'); }
        }
        if (desired.reasoningEffort !== undefined) main.reasoningEffort = desired.reasoningEffort ?? undefined;
        if (desired.accountProfileId) main.accountProfileId = desired.accountProfileId;
        main.provider = desired.provider!; main.currentModel = desired.model ?? main.currentModel;
        main.status = 'idle'; runtime = { ...main }; return main;
      }, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    changeModel.mockImplementation(async (_id, model, reasoningEffort, _target, provider) => {
      if (kind === 'account-model-reject' && changeModel.mock.calls.length === 2) {
        return { success: true, data: { ...main, status: 'error' } };
      }
      try { return { success: true, data: { ...await queue.requestChange(main.id, { model, provider, reasoningEffort }) } }; }
      catch (error) { return { success: false, error: { message: String(error) } }; }
    });
    switchSession.mockImplementation(async (_id, profileId) => {
      await queue.requestChange(main.id, { provider: main.provider, accountProfileId: profileId,
        accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
      return { success: true };
    });
    const latest: PendingSelection = kind === 'same-provider' ? { ...first, model: 'example-new-model' }
      : kind === 'model-default' ? { ...first, model: null } : second;
    service.select('history-1', first);
    let finished = false;
    const action = service.prepare(conversation()).then(value => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0); expect(changeModel).toHaveBeenCalledOnce(); expect(finished).toBe(false);
      if (kind.startsWith('account-')) service.chooseAccount('history-1', 'example-recovery');
      else service.select('history-1', latest);
      if (kind.startsWith('held')) held.resolve();
      else if (kind === 'terminal') main.status = 'terminated';
      else if (kind !== 'queued-newer') main.status = 'error';
      runtime = { ...main };
      await vi.advanceTimersByTimeAsync(250);
      if (kind === 'queued-newer') {
        expect(finished).toBe(false); expect(main.desiredRuntime?.provider).toBe('claude');
        main.status = 'idle'; queue.onSettled(main); await vi.advanceTimersByTimeAsync(0);
        expect(finished).toBe(false); expect(main.desiredRuntime?.provider).toBe('claude');
        heldLatest.resolve(); await vi.advanceTimersByTimeAsync(250);
      }
      expect(finished).toBe(true);
      expect(service.selection('history-1')).toBe(kind.startsWith('account-') ? first : latest);
      if (kind === 'terminal' || kind === 'model-default' || kind === 'account-model-reject') expect(await action).toBeNull();
      else expect(await action).toBe(main.id);
      if (kind !== 'terminal' && !kind.startsWith('account-')) expect(changeModel).toHaveBeenNthCalledWith(2, main.id, latest.model ?? undefined, latest.reasoning, undefined, latest.provider);
      if (kind === 'queued-newer') expect(applied).toEqual([second.model]);
      if (kind === 'held-old-success') expect(applied).toEqual([first.model, second.model]);
      if (kind === 'held-old-failure') expect(applied).toEqual([first.model, second.model]);
      if (kind === 'same-provider') expect(applied).toEqual([latest.model]);
      if (kind.startsWith('account-')) {
        expect(switchSession).toHaveBeenCalledOnce();
        expect(main.accountProfileId).toBe('example-recovery');
        expect(changeModel).toHaveBeenCalledTimes(2);
        expect(changeModel).toHaveBeenLastCalledWith(main.id, first.model, first.reasoning, undefined, first.provider);
        if (kind === 'account-recovery') {
          expect(service.confirmedSelectionForInstance(main.id, 'codex', main.currentModel)).toEqual(first);
        } else {
          expect(service.error('history-1')).toContain('selected model did not finish starting');
          expect(service.confirmedSelectionForInstance(main.id, 'codex', main.currentModel)).toBeNull();
          expect(service.accountChoice('history-1')).toBe('example-recovery');
        }
      }
    } finally {
      held.resolve(); heldLatest.resolve(); main.status = 'terminated'; runtime = { ...main }; queue.onSettled(main);
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled([action]); TestBed.resetTestingModule();
    }
  });
  it('cross-provider queued model never sends its new account through the old provider', async () => {
    vi.useFakeTimers();
    const main = { ...runtime, status: 'idle', accountProfileId: 'example-original' } as Instance;
    runtime = main;
    const held = deferred<void>();
    const accountProviders: string[] = [];
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange: async (_id, desired) => {
        if (desired.provider === 'claude' && !desired.accountProfileId) await held.promise;
        main.provider = desired.provider!; main.currentModel = desired.model ?? main.currentModel;
        if (desired.reasoningEffort !== undefined) main.reasoningEffort = desired.reasoningEffort ?? undefined;
        if (desired.accountProfileId) main.accountProfileId = desired.accountProfileId;
        main.status = 'idle'; runtime = { ...main }; return main;
      }, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    let firstRequest = true;
    changeModel.mockImplementation(async (_id, model, reasoningEffort, _target, provider) => {
      if (firstRequest) { firstRequest = false; main.status = 'initializing'; }
      return { success: true, data: { ...await queue.requestChange(main.id, { model, provider, reasoningEffort }) } };
    });
    switchSession.mockImplementation(async (_id, profileId) => {
      accountProviders.push(main.provider!);
      await queue.requestChange(main.id, { provider: main.provider, accountProfileId: profileId,
        accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
      return { success: true };
    });
    service.select('history-1', second);
    let finished = false;
    const action = service.prepare(conversation()).then(value => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0); expect(changeModel).toHaveBeenCalledOnce();
      service.chooseAccount('history-1', 'example-claude-account');
      await vi.advanceTimersByTimeAsync(250);
      expect(finished).toBe(false); expect(switchSession).not.toHaveBeenCalled();
      main.status = 'idle'; queue.onSettled(main); await vi.advanceTimersByTimeAsync(0);
      expect(main.provider).toBe('codex'); expect(finished).toBe(false);
      held.resolve(); await vi.advanceTimersByTimeAsync(250);
      expect(await action).toBe(main.id); expect(main.provider).toBe('claude');
      expect(accountProviders).toEqual(['claude']); expect(main.accountProfileId).toBe('example-claude-account');
      expect(changeModel).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve(); main.status = 'terminated'; runtime = { ...main }; queue.onSettled(main);
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled([action]); TestBed.resetTestingModule();
    }
  });


  it.each(['wrong-provider', 'wrong-model', 'missing-data'] as const)('account-only draft cannot bypass invalid model response %s', async kind => {
    vi.useFakeTimers();
    const held = deferred<IpcResponse>();
    changeModel.mockReturnValueOnce(held.promise);
    service.select('history-1', first);
    let finished = false;
    const action = service.prepare(conversation()).then(value => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0); expect(changeModel).toHaveBeenCalledOnce();
      service.chooseAccount('history-1', 'example-recovery');
      held.resolve({ success: true, ...(kind === 'missing-data' ? {} : { data: { ...runtime,
        ...(kind === 'wrong-provider' ? { provider: 'claude' } : { currentModel: 'example-wrong-model' }) } }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true); expect(await action).toBeNull();
      expect(switchSession).not.toHaveBeenCalled();
      expect(service.selection('history-1')).toBe(first);
      expect(service.accountChoice('history-1')).toBe('example-recovery');
    } finally {
      held.resolve({ success: false }); runtime = { ...runtime, status: 'terminated' };
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled([action]); TestBed.resetTestingModule();
    }
  });


  it('re-confirms the exact earlier selection object behind a newer held write', async () => {
    vi.useFakeTimers();
    const main = { ...runtime, status: 'idle', reasoningEffort: first.reasoning } as Instance;
    runtime = { ...main, status: 'initializing' };
    const held = deferred<void>();
    const applied: string[] = [];
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange: async (_id, desired) => {
        applied.push(desired.model!);
        main.status = 'initializing'; runtime = { ...main };
        if (desired.provider === 'claude') await held.promise;
        if ((main.status as string) === 'terminated') throw new Error('Example terminated');
        main.provider = desired.provider!; main.currentModel = desired.model;
        main.reasoningEffort = desired.reasoningEffort ?? undefined;
        main.status = 'idle'; runtime = { ...main }; return main;
      }, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    changeModel.mockImplementation(async (_id, model, reasoningEffort, _target, provider) => {
      try { return { success: true, data: { ...await queue.requestChange(main.id, { model, provider, reasoningEffort }) } }; }
      catch (error) { return { success: false, error: { message: String(error) } }; }
    });
    service.select('history-1', first);
    let finished = false;
    const action = service.prepare(conversation()).then(value => { finished = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0); expect(changeModel).toHaveBeenCalledOnce(); expect(finished).toBe(false);
      main.status = 'initializing'; service.select('history-1', second);
      await vi.advanceTimersByTimeAsync(250); expect(changeModel).toHaveBeenCalledTimes(2);
      main.status = 'idle'; queue.onSettled(main); await vi.advanceTimersByTimeAsync(0);
      expect(applied).toEqual([second.model]); expect(finished).toBe(false);
      service.select('history-1', first); // Reuse the public API's exact previously confirmed object.
      await vi.advanceTimersByTimeAsync(250);
      expect(changeModel).toHaveBeenCalledTimes(3); expect(finished).toBe(false);
      expect(main.desiredRuntime?.provider).toBe(first.provider);
      held.resolve(); await vi.advanceTimersByTimeAsync(250);
      expect(await action).toBe(main.id);
      expect(main.provider).toBe(first.provider); expect(main.currentModel).toBe(first.model);
      expect(applied).toEqual([second.model, first.model]); expect(changeModel).toHaveBeenCalledTimes(4);
      expect(service.selection('history-1')).toBe(first);
    } finally {
      held.resolve(); main.status = 'terminated'; runtime = { ...main }; queue.onSettled(main);
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled([action]); TestBed.resetTestingModule();
    }
  });

  it.each([
    ['during', 'codex', false, 'codex'], ['during', 'claude', false, 'codex'],
    ['after', 'codex', false, 'codex'], ['after', 'claude', false, 'codex'],
    ['after-complete', 'codex', false, 'codex'], ['after-complete', 'claude', false, 'codex'],
    ['after', 'claude', true, 'codex'],
    ['during', 'codex', false, 'claude'], ['during', 'claude', false, 'claude'],
    ['prior-prepare', 'claude', false, 'codex'],
  ] as const)('binds an account picked %s a held %s change with explicit selection %s from %s', async (when, provider, explicit, initialProvider) => {
    vi.useFakeTimers();
    const archived = conversation('example-imported-thread');
    const during = when === 'during' || when === 'prior-prepare';
    const main = { ...runtime, provider: initialProvider, status: when === 'prior-prepare' ? 'idle' : 'busy', accountProfileId: 'example-original',
      historyThreadId: archived.entry.id } as Instance;
    runtime = { ...main };
    const heldProvider = deferred<void>();
    const heldAccount = deferred<void>();
    const actions: Promise<unknown>[] = [];
    const applyChange = vi.fn(async (_id: string, desired: NonNullable<Instance['desiredRuntime']>) => {
      main.status = 'initializing';
      if (desired.accountProfileId) {
        main.accountProfileId = desired.accountProfileId;
        runtime = { ...main };
        await heldAccount.promise;
      } else {
        main.provider = desired.provider ?? main.provider;
        // The actual respawn can stamp main's provider before the final state
        // packet. Preserve the renderer's old provider through held startup.
        runtime = { ...main, provider: initialProvider };
        await heldProvider.promise;
      }
      if ((main.status as string) === 'terminated') throw new Error('Example test runtime stopped');
      if (desired.model !== undefined) main.currentModel = desired.model;
      if (desired.reasoningEffort !== undefined) main.reasoningEffort = desired.reasoningEffort ?? undefined;
      main.status = 'idle'; runtime = { ...main }; return main;
    });
    const queue = new DesiredRuntimeQueue({ getInstance: () => main, isAdapterOnLoan: () => false,
      applyChange, publishPendingState: () => { runtime = { ...main }; }, notifyApplyFailure: vi.fn() });
    let settled = false;
    let action: Promise<string | null> | undefined;
    try {
      const parkProviderChange = async () => {
        const previous = queue.requestChange(main.id, { provider,
          model: provider === 'claude' ? second.model! : first.model!,
          reasoningEffort: provider === 'claude' ? second.reasoning : first.reasoning });
        void previous.catch(() => undefined); actions.push(previous); await previous;
      };
      if (when !== 'prior-prepare') await parkProviderChange();
      const heavyRestore = vi.fn();
      const backend = new SessionRevivalService({ getInstance: () => main, getAllInstances: () => [main] } as never,
        { historyRestore: { restore: heavyRestore }, history: { getEntries: () => [archived.entry] } });
      restoreEntry.mockImplementation(async historyEntryId => {
        const revived = await backend.revive({ historyEntryId, reviveIfArchived: true, reason: 'history-restore' });
        return { success: revived.status === 'live', instanceId: revived.instanceId };
      });
      const pickedProvider = explicit ? second.provider : archived.entry.provider;
      switchSession.mockImplementation(async (_id: string, profileId: string) => {
        if (main.provider !== pickedProvider) return { success: false, error: { message: 'Example profile belongs to another provider' } };
        await queue.requestChange(main.id, { provider: main.provider, accountProfileId: profileId,
          accountHandoffKind: 'explicit', accountHandoffConfirmed: true });
        return { success: true };
      });
      changeModel.mockImplementation(async (_id, model, reasoningEffort, _target, selectedProvider) => ({
        success: true, data: { ...await queue.requestChange(main.id, { model, reasoningEffort, provider: selectedProvider }) },
      }));
      expect(await service.restore(archived)).toBe(main.id);
      if (when === 'prior-prepare') {
        expect(await service.prepare(archived)).toBe(main.id); // Keep metadata when a later send/start does not complete.
        main.status = 'busy'; runtime = { ...main };
        await parkProviderChange();
      }
      if (during) {
        service.chooseAccount(archived.entry.id, 'example-picked');
        action = service.prepare(archived).then(value => { settled = true; return value; }); actions.push(action);
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false); expect(switchSession).not.toHaveBeenCalled();
      }
      main.status = 'idle'; queue.onSettled(main); await vi.advanceTimersByTimeAsync(0);
      expect(applyChange).toHaveBeenCalledOnce();
      expect(runtime.provider).toBe(initialProvider);
      expect(runtime.desiredRuntime?.provider).toBe(provider);
      expect(settled).toBe(false); expect(switchSession).not.toHaveBeenCalled();
      heldProvider.resolve(); await vi.advanceTimersByTimeAsync(250);
      if (!during) {
        if (when === 'after-complete') {
          expect(await service.prepare(archived)).toBe(main.id);
          service.complete(archived.entry.id);
        }
        if (explicit) service.select(archived.entry.id, second);
        service.chooseAccount(archived.entry.id, 'example-picked');
        action = service.prepare(archived).then(value => { settled = true; return value; }); actions.push(action);
        await vi.advanceTimersByTimeAsync(0);
      }
      const appliesAccount = provider === pickedProvider;
      if (appliesAccount) {
        expect(settled).toBe(false);
        expect(switchSession).toHaveBeenCalledExactlyOnceWith(main.id, 'example-picked');
        expect(runtime.desiredRuntime?.accountProfileId).toBe('example-picked');
      } else expect(switchSession).not.toHaveBeenCalled();
      heldAccount.resolve(); await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBe(true); expect(await action).toBe(main.id);
      expect(main.provider).toBe(provider);
      expect(main.accountProfileId).toBe(appliesAccount ? 'example-picked' : 'example-original');
      expect(runtime.desiredRuntime).toBeUndefined();
      expect(service.error(archived.entry.id)).toBeNull();
      expect(service.accountChoice(archived.entry.id)).toBe('example-picked');
      expect(service.restoredInstanceId(archived.entry.id)).toBe(main.id);
      expect(applyChange).toHaveBeenCalledTimes(appliesAccount ? 2 : 1);
      expect(changeModel).toHaveBeenCalledTimes(explicit ? 1 : 0);
      expect(heavyRestore).not.toHaveBeenCalled(); expect(restoreEntry).toHaveBeenCalledOnce();
      expect(terminateInstance).not.toHaveBeenCalled();
    } finally {
      main.status = 'terminated'; runtime = { ...main }; queue.onSettled(main);
      heldProvider.resolve(); heldAccount.resolve();
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled(actions); TestBed.resetTestingModule();
    }
  });

  it('retains an archived-provider account draft after a provider wait times out and refuses late release', async () => {
    vi.useFakeTimers();
    const archived = conversation();
    runtime = { ...runtime, status: 'initializing', desiredRuntime: { provider: 'claude', model: second.model! } };
    let action: Promise<string | null> | undefined;
    let settled = false;
    try {
      await service.restore(archived);
      service.chooseAccount(archived.entry.id, 'example-codex-picked');
      action = service.prepare(archived).then(value => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(29_900);
      expect(settled).toBe(false); expect(switchSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true); expect(await action).toBeNull();
      expect(service.accountChoice(archived.entry.id)).toBe('example-codex-picked');
      runtime = { ...runtime, provider: 'claude', status: 'idle', currentModel: second.model!, desiredRuntime: undefined };
      await vi.advanceTimersByTimeAsync(250);
      expect(await action).toBeNull(); expect(switchSession).not.toHaveBeenCalled();
      expect(await service.prepare(archived)).toBe('real-1');
      expect(switchSession).not.toHaveBeenCalled();
      expect(restoreEntry).toHaveBeenCalledOnce();
    } finally {
      runtime = { ...runtime, status: 'terminated' };
      await vi.advanceTimersByTimeAsync(30_000); await Promise.allSettled(action ? [action] : []); TestBed.resetTestingModule();
    }
  });

});
