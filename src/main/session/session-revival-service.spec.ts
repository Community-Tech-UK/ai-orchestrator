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
  let service: SessionRevivalService;

  beforeEach(() => {
    getInstance.mockReset();
    getAllInstances.mockReset();
    restore.mockReset();
    getEntries.mockReset();
    getAllInstances.mockReturnValue([]);
    getEntries.mockReturnValue([]);
    service = new SessionRevivalService(
      {
        getInstance,
        getAllInstances,
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
});
