import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecoverSessionResult,
  SessionRecoveryCandidate,
} from '../../../../shared/types/session-recovery.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { SessionRecoveryStore } from './session-recovery.store';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function candidate(overrides: Partial<SessionRecoveryCandidate> = {}): SessionRecoveryCandidate {
  return {
    recoveryKey: 'recovery:claude:new',
    sourceInstanceId: 'source-1',
    historyThreadId: 'thread-1',
    provider: 'claude',
    modelId: 'sonnet',
    displayName: 'Recovered auth fix',
    workingDirectory: '/repo',
    lastActivityAt: 1_700_000_000_000,
    historyCoveredThrough: 1_699_999_990_000,
    recoveredMessageCount: 4,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
    ...overrides,
  };
}

describe('SessionRecoveryStore', () => {
  const api = {
    listRecoveryCandidates: vi.fn(),
    recoverSession: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.listRecoveryCandidates.mockResolvedValue([]);
    api.recoverSession.mockResolvedValue({
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    } satisfies RecoverSessionResult);
    TestBed.configureTestingModule({
      providers: [
        SessionRecoveryStore,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
      ],
    });
  });

  it('loads initial recovery candidates with visible progress and no automatic restore', async () => {
    const item = candidate();
    api.listRecoveryCandidates.mockResolvedValueOnce([item]);
    const store = TestBed.inject(SessionRecoveryStore);

    const refresh = store.refresh();

    expect(store.loading()).toBe(true);
    await refresh;
    expect(store.loading()).toBe(false);
    expect(store.error()).toBeNull();
    expect(store.candidates()).toEqual([item]);
    expect(api.listRecoveryCandidates).toHaveBeenCalledOnce();
    expect(api.recoverSession).not.toHaveBeenCalled();
  });

  it('keeps existing candidates and records a refresh error when discovery fails', async () => {
    const item = candidate();
    api.listRecoveryCandidates.mockResolvedValueOnce([item]);
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    api.listRecoveryCandidates.mockRejectedValueOnce(new Error('Recovery index unavailable'));
    await store.refresh();

    expect(store.candidates()).toEqual([item]);
    expect(store.loading()).toBe(false);
    expect(store.error()).toBe('Recovery index unavailable');
  });

  it('ignores stale refresh responses that resolve after a newer request', async () => {
    const oldRefresh = deferred<SessionRecoveryCandidate[]>();
    const newRefresh = deferred<SessionRecoveryCandidate[]>();
    api.listRecoveryCandidates
      .mockReturnValueOnce(oldRefresh.promise)
      .mockReturnValueOnce(newRefresh.promise);
    const store = TestBed.inject(SessionRecoveryStore);

    const first = store.refresh();
    const second = store.refresh();
    newRefresh.resolve([candidate({ recoveryKey: 'recovery:claude:newest', lastActivityAt: 20 })]);
    await second;
    expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:newest']);

    oldRefresh.resolve([candidate({ recoveryKey: 'recovery:claude:stale', lastActivityAt: 10 })]);
    await first;

    expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:newest']);
    expect(store.loading()).toBe(false);
  });

  it('tracks an in-flight restore and suppresses duplicate restore calls', async () => {
    const restore = deferred<RecoverSessionResult>();
    api.recoverSession.mockReturnValueOnce(restore.promise);
    const store = TestBed.inject(SessionRecoveryStore);

    const first = store.recover('recovery:claude:new');
    const duplicate = store.recover('recovery:claude:new');

    expect(store.recoveringKey()).toBe('recovery:claude:new');
    expect(api.recoverSession).toHaveBeenCalledOnce();
    await expect(duplicate).resolves.toBeNull();

    const result: RecoverSessionResult = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    };
    restore.resolve(result);
    await expect(first).resolves.toEqual(result);
    expect(store.recoveringKey()).toBeNull();
  });

  it('invalidates candidates after successful recovery', async () => {
    const item = candidate();
    const result: RecoverSessionResult = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    };
    api.listRecoveryCandidates.mockResolvedValueOnce([item]);
    api.recoverSession.mockResolvedValueOnce(result);
    api.listRecoveryCandidates.mockResolvedValueOnce([]);
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    await expect(store.recover(item.recoveryKey)).resolves.toEqual(result);

    expect(api.recoverSession).toHaveBeenCalledWith({ recoveryKey: item.recoveryKey });
    expect(api.listRecoveryCandidates).toHaveBeenCalledTimes(2);
    expect(store.candidates()).toEqual([]);
    expect(store.error()).toBeNull();
  });

  it('removes the recovered candidate before a failed post-recovery refresh while retaining others', async () => {
    const restored = candidate({
      recoveryKey: 'recovery:claude:restored',
      sourceInstanceId: 'source-restored',
      displayName: 'Restored autosave',
    });
    const other = candidate({
      recoveryKey: 'recovery:claude:other',
      sourceInstanceId: 'source-other',
      displayName: 'Other autosave',
    });
    const restore = deferred<RecoverSessionResult>();
    const refreshAfterRecovery = deferred<SessionRecoveryCandidate[]>();
    const result: RecoverSessionResult = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    };
    api.listRecoveryCandidates.mockResolvedValueOnce([restored, other]);
    api.recoverSession.mockReturnValueOnce(restore.promise);
    api.listRecoveryCandidates.mockReturnValueOnce(refreshAfterRecovery.promise);
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    const recovery = store.recover(restored.recoveryKey);
    restore.resolve(result);

    await vi.waitFor(() => expect(api.listRecoveryCandidates).toHaveBeenCalledTimes(2));
    expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:other']);

    refreshAfterRecovery.reject(new Error('Recovery refresh failed'));
    await expect(recovery).resolves.toEqual(result);

    expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:other']);
    expect(store.error()).toBe('Recovery refresh failed');
    expect(store.recoveringKey()).toBeNull();
  });

  it('resolves recovery before the post-success candidate refresh settles', async () => {
    const restored = candidate({
      recoveryKey: 'recovery:claude:restored',
      sourceInstanceId: 'source-restored',
      displayName: 'Restored autosave',
    });
    const other = candidate({
      recoveryKey: 'recovery:claude:other',
      sourceInstanceId: 'source-other',
      displayName: 'Other autosave',
    });
    const restore = deferred<RecoverSessionResult>();
    const refreshAfterRecovery = deferred<SessionRecoveryCandidate[]>();
    const result: RecoverSessionResult = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    };
    api.listRecoveryCandidates.mockResolvedValueOnce([restored, other]);
    api.recoverSession.mockReturnValueOnce(restore.promise);
    api.listRecoveryCandidates.mockReturnValueOnce(refreshAfterRecovery.promise);
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    const recovery = store.recover(restored.recoveryKey);
    let resolved: RecoverSessionResult | null = null;
    recovery.then((value) => {
      resolved = value;
    });
    restore.resolve(result);

    await vi.waitFor(() => expect(api.listRecoveryCandidates).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(resolved).toEqual(result);
    expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:other']);

    refreshAfterRecovery.resolve([]);
    await recovery;
  });

  it('keeps stale background refresh failures from restoring the recovered key or overwriting newer results', async () => {
    const restored = candidate({
      recoveryKey: 'recovery:claude:restored',
      sourceInstanceId: 'source-restored',
      displayName: 'Restored autosave',
    });
    const other = candidate({
      recoveryKey: 'recovery:claude:other',
      sourceInstanceId: 'source-other',
      displayName: 'Other autosave',
    });
    const newest = candidate({
      recoveryKey: 'recovery:claude:newest',
      sourceInstanceId: 'source-newest',
      displayName: 'Newest autosave',
    });
    const restore = deferred<RecoverSessionResult>();
    const backgroundRefresh = deferred<SessionRecoveryCandidate[]>();
    const result: RecoverSessionResult = {
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    api.listRecoveryCandidates.mockResolvedValueOnce([restored, other]);
    api.recoverSession.mockReturnValueOnce(restore.promise);
    api.listRecoveryCandidates.mockReturnValueOnce(backgroundRefresh.promise);
    api.listRecoveryCandidates.mockResolvedValueOnce([newest]);
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    try {
      const recovery = store.recover(restored.recoveryKey);
      restore.resolve(result);
      await expect(recovery).resolves.toEqual(result);

      await store.refresh();
      expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:newest']);
      expect(store.error()).toBeNull();

      backgroundRefresh.reject(new Error('Stale recovery refresh failed'));
      await Promise.resolve();
      await Promise.resolve();

      expect(store.candidates().map((item) => item.recoveryKey)).toEqual(['recovery:claude:newest']);
      expect(store.error()).toBeNull();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('retains the candidate and exposes a retryable error after failed recovery', async () => {
    const item = candidate();
    api.listRecoveryCandidates.mockResolvedValueOnce([item]);
    api.recoverSession.mockRejectedValueOnce(new Error('Recovery provider is unavailable'));
    const store = TestBed.inject(SessionRecoveryStore);
    await store.refresh();

    await expect(store.recover(item.recoveryKey)).resolves.toBeNull();

    expect(store.candidates()).toEqual([item]);
    expect(store.recoveringKey()).toBeNull();
    expect(store.error()).toBe('Recovery provider is unavailable');
    expect(api.listRecoveryCandidates).toHaveBeenCalledOnce();
  });
});
