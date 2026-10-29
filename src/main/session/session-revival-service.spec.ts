import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { SessionRevivalService } from './session-revival-service';

function liveInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'live-1',
    status: 'idle',
    outputBuffer: [],
    ...overrides,
  } as Instance;
}

describe('SessionRevivalService', () => {
  const getInstance = vi.fn();
  const getAllInstances = vi.fn();
  const restore = vi.fn();
  const getEntries = vi.fn();
  const restartInstance = vi.fn();
  let service: SessionRevivalService;

  beforeEach(() => {
    getInstance.mockReset();
    getAllInstances.mockReset();
    restore.mockReset();
    getEntries.mockReset();
    restartInstance.mockReset();
    getAllInstances.mockReturnValue([]);
    getEntries.mockReturnValue([]);
    service = new SessionRevivalService(
      {
        getInstance,
        getAllInstances,
        restartInstance,
      } as unknown as InstanceManager,
      {
        historyRestore: { restore },
        history: { getEntries },
      },
    );
  });

  it('returns a live instance without restoring history', async () => {
    getInstance.mockReturnValue(liveInstance());

    await expect(service.revive({
      instanceId: 'live-1',
      reviveIfArchived: false,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'live',
      instanceId: 'live-1',
    });

    expect(restore).not.toHaveBeenCalled();
  });

  it('returns a live instance matched by thread metadata before restoring history', async () => {
    getInstance.mockReturnValue(undefined);
    getAllInstances.mockReturnValue([
      liveInstance({
        id: 'revived-live-1',
        historyThreadId: 'thread-1',
        providerSessionId: 'provider-session-1',
      }),
    ]);

    await expect(service.revive({
      instanceId: 'archived-instance-1',
      historyEntryId: 'thread-1',
      providerSessionId: 'provider-session-1',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'live',
      instanceId: 'revived-live-1',
    });

    expect(restore).not.toHaveBeenCalled();
  });

  it('fails archived targets when revival is disabled', async () => {
    getInstance.mockReturnValue(undefined);

    await expect(service.revive({
      historyEntryId: 'history-1',
      reviveIfArchived: false,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'target_not_live',
    });

    expect(restore).not.toHaveBeenCalled();
  });

  it('revives archived history entries through the restore coordinator', async () => {
    getInstance.mockReturnValue(undefined);
    restore.mockResolvedValue({
      instanceId: 'revived-1',
      restoredMessages: [{ id: 'msg-1' }],
      restoreMode: 'replay-fallback',
      sessionId: 'session-1',
      historyThreadId: 'history-1',
    });

    await expect(service.revive({
      historyEntryId: 'history-1',
      workingDirectory: '/repo',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'revived',
      instanceId: 'revived-1',
      restoreMode: 'replay-fallback',
    });

    expect(restore).toHaveBeenCalledWith(expect.anything(), 'history-1', {
      workingDirectory: '/repo',
    });
  });

  it('resolves an archived live-thread wakeup by original instance id', async () => {
    getInstance.mockReturnValue(undefined);
    getEntries.mockReturnValue([
      {
        id: 'history-entry-1',
        originalInstanceId: 'instance-1',
        historyThreadId: 'thread-1',
        sessionId: 'provider-session-1',
      },
    ]);
    restore.mockResolvedValue({
      instanceId: 'revived-1',
      restoredMessages: [],
      restoreMode: 'native-resume',
      sessionId: 'provider-session-1',
      historyThreadId: 'thread-1',
    });

    await expect(service.revive({
      instanceId: 'instance-1',
      providerSessionId: 'provider-session-1',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'revived',
      instanceId: 'revived-1',
    });

    expect(restore).toHaveBeenCalledWith(expect.anything(), 'history-entry-1', {
      workingDirectory: undefined,
    });
  });

  it('reports restore failures without throwing', async () => {
    getInstance.mockReturnValue(undefined);
    restore.mockRejectedValue(new Error('restore failed'));

    await expect(service.revive({
      historyEntryId: 'history-1',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'resume_failed',
      error: 'restore failed',
    });
  });

  it('reports history lookup failures without throwing', async () => {
    getInstance.mockReturnValue(undefined);
    getEntries.mockImplementation(() => {
      throw new Error('history unavailable');
    });

    await expect(service.revive({
      instanceId: 'instance-1',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    })).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'resume_failed',
      error: 'history unavailable',
    });
  });

  describe('a conversation that is still open', () => {
    const wakeup = {
      instanceId: 'closed-original',
      historyEntryId: 'history-entry-1',
      providerSessionId: 'provider-session-1',
      reviveIfArchived: true,
      reason: 'thread-wakeup',
    } as const;
    const copy = (overrides: Partial<Instance>) => liveInstance({ providerSessionId: 'provider-session-1', ...overrides });

    it('uses a sleeping copy instead of opening another (sending to it wakes it)', async () => {
      getAllInstances.mockReturnValue([copy({ id: 'sleeping-copy', status: 'hibernated' })]);

      await expect(service.revive(wakeup)).resolves.toMatchObject({ status: 'live', instanceId: 'sleeping-copy' });
      expect(restore).not.toHaveBeenCalled();
      expect(restartInstance).not.toHaveBeenCalled();
    });

    it.each(['error', 'cancelled'] as const)('restarts a copy in %s in place instead of opening another', async (status) => {
      getAllInstances.mockReturnValue([copy({ id: 'stopped-copy', status })]);
      restartInstance.mockResolvedValue({ success: true, method: 'native-resume' });

      await expect(service.revive(wakeup)).resolves.toMatchObject({ status: 'revived', instanceId: 'stopped-copy' });
      expect(restartInstance).toHaveBeenCalledExactlyOnceWith('stopped-copy');
      expect(restore).not.toHaveBeenCalled();
    });

    it('reports a failed restart without opening a second copy', async () => {
      getAllInstances.mockReturnValue([copy({ id: 'stopped-copy', status: 'error' })]);
      restartInstance.mockResolvedValue({ success: false, error: 'provider unavailable' });

      await expect(service.revive(wakeup)).resolves.toMatchObject({
        status: 'failed', failureCode: 'resume_failed', error: 'provider unavailable',
      });
      expect(restore).not.toHaveBeenCalled();
    });

    it('leaves a stopped copy alone when revival is turned off', async () => {
      getAllInstances.mockReturnValue([copy({ id: 'stopped-copy', status: 'error' })]);

      await expect(service.revive({ ...wakeup, reviveIfArchived: false })).resolves.toMatchObject({
        status: 'failed', failureCode: 'target_not_live',
      });
      expect(restartInstance).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    });

    it('uses a sleeping copy even when revival is turned off, because it is still open', async () => {
      getAllInstances.mockReturnValue([copy({ id: 'sleeping-copy', status: 'hibernated' })]);

      await expect(service.revive({ ...wakeup, reviveIfArchived: false })).resolves.toMatchObject({
        status: 'live', instanceId: 'sleeping-copy',
      });
      expect(restore).not.toHaveBeenCalled();
      expect(restartInstance).not.toHaveBeenCalled();
    });

    it('still finds an open copy when the history lookup fails', async () => {
      getEntries.mockImplementation(() => { throw new Error('history unavailable'); });
      getAllInstances.mockReturnValue([copy({ id: 'stopped-copy', status: 'error' })]);
      restartInstance.mockResolvedValue({ success: true, method: 'replay-fallback' });

      await expect(service.revive(wakeup)).resolves.toMatchObject({ status: 'revived', instanceId: 'stopped-copy' });
      expect(restartInstance).toHaveBeenCalledExactlyOnceWith('stopped-copy');
      expect(restore).not.toHaveBeenCalled();
    });

    it('prefers a copy that can take input over restarting a stopped one', async () => {
      getAllInstances.mockReturnValue([
        copy({ id: 'stopped-copy', status: 'error' }),
        copy({ id: 'sleeping-copy', status: 'hibernated' }),
      ]);

      await expect(service.revive(wakeup)).resolves.toMatchObject({ status: 'live', instanceId: 'sleeping-copy' });
      expect(restartInstance).not.toHaveBeenCalled();
    });

    it.each(['terminated', 'failed', 'superseded'] as const)('reopens from history when the only copy is %s', async (status) => {
      getAllInstances.mockReturnValue([copy({ id: 'closed-copy', status })]);
      getEntries.mockReturnValue([{ id: 'history-entry-1', sessionId: 'provider-session-1' }]);
      restore.mockResolvedValue({ instanceId: 'restored-1', restoredMessages: [], restoreMode: 'native-resume' });

      await expect(service.revive(wakeup)).resolves.toMatchObject({ status: 'revived', instanceId: 'restored-1' });
      expect(restartInstance).not.toHaveBeenCalled();
    });

    it('finds the open copy when reopened by history entry alone', async () => {
      getEntries.mockReturnValue([{ id: 'history-entry-1', historyThreadId: 'thread-1', sessionId: 'provider-session-1' }]);
      getAllInstances.mockReturnValue([liveInstance({ id: 'open-copy', historyThreadId: 'thread-1', status: 'idle' })]);

      await expect(service.revive({
        historyEntryId: 'history-entry-1', reviveIfArchived: true, reason: 'history-restore',
      })).resolves.toMatchObject({ status: 'live', instanceId: 'open-copy' });
      expect(restore).not.toHaveBeenCalled();
    });
  });
});
