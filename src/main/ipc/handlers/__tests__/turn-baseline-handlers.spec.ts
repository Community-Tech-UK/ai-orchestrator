/**
 * Turn file-change handler: registers the one channel the transcript asks, and
 * hooks the baseline service up to the instance manager so snapshots happen
 * whether or not anyone is looking at the session.
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { TurnFileBaselineService, type TurnBaselineInstanceInfo } from '../../../vcs/turn-file-baseline';
import { registerTurnBaselineHandlers } from '../turn-baseline-handlers';

type InstanceLookup = (instanceId: string) => TurnBaselineInstanceInfo | undefined;

describe('registerTurnBaselineHandlers', () => {
  let manager: EventEmitter & { getInstance: ReturnType<typeof vi.fn<InstanceLookup>> };

  beforeEach(() => {
    handlers.clear();
    TurnFileBaselineService._resetForTesting();
    manager = Object.assign(new EventEmitter(), { getInstance: vi.fn<InstanceLookup>() });
  });

  it('registers the turn file-change channel', () => {
    registerTurnBaselineHandlers({ instanceManager: manager });
    expect(handlers.has(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)).toBe(true);
    expect(IPC_CHANNELS.VCS_TURN_FILE_CHANGES).toBe('vcs:turn-file-changes');
  });

  it('answers with the service result, and says so plainly when nothing was recorded', async () => {
    registerTurnBaselineHandlers({ instanceManager: manager });
    const response = await handlers.get(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)!({}, { instanceId: 'inst-1', turnKey: 'u1' });
    expect(response).toEqual({ success: true, data: { state: 'unavailable', reason: 'no-baseline' } });
  });

  it('rejects a request that does not name an instance and a turn', async () => {
    registerTurnBaselineHandlers({ instanceManager: manager });
    const handler = handlers.get(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)!;
    for (const payload of [undefined, {}, { instanceId: 'a' }, { instanceId: '', turnKey: 'u' }, { instanceId: 'a', turnKey: 7 }]) {
      const response = await handler({}, payload);
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('turns away a sender the app does not trust', async () => {
    const refusal: IpcResponse = { success: false, error: { code: 'UNTRUSTED', message: 'no', timestamp: 1 } };
    registerTurnBaselineHandlers({ instanceManager: manager, ensureTrustedSender: () => refusal });
    const response = await handlers.get(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)!({}, { instanceId: 'inst-1', turnKey: 'u1' });
    expect(response).toBe(refusal);
  });

  it('starts watching the instance manager, looking up each session when a turn begins', async () => {
    manager.getInstance.mockReturnValue({ workingDirectory: '/does/not/exist', executionLocation: { type: 'remote' } });
    registerTurnBaselineHandlers({ instanceManager: manager });

    manager.emit('provider:normalized-event', {
      instanceId: 'inst-1',
      timestamp: 1,
      event: { kind: 'output', content: 'go', messageType: 'user', messageId: 'u1', timestamp: 1 },
    });
    const response = await handlers.get(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)!({}, { instanceId: 'inst-1', turnKey: 'u1' });

    expect(manager.getInstance).toHaveBeenCalledWith('inst-1');
    expect(response).toEqual({ success: true, data: { state: 'unavailable', reason: 'remote' } });
  });

  it('says there is no baseline for a session the manager does not know', async () => {
    manager.getInstance.mockReturnValue(undefined);
    registerTurnBaselineHandlers({ instanceManager: manager });
    manager.emit('provider:normalized-event', {
      instanceId: 'ghost',
      timestamp: 1,
      event: { kind: 'output', content: 'go', messageType: 'user', messageId: 'u1', timestamp: 1 },
    });
    const response = await handlers.get(IPC_CHANNELS.VCS_TURN_FILE_CHANGES)!({}, { instanceId: 'ghost', turnKey: 'u1' });
    expect(response).toEqual({ success: true, data: { state: 'unavailable', reason: 'no-baseline' } });
  });
});
