import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { InstanceManager } from '../../../instance/instance-manager';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  sendMessage: vi.fn(),
  listMessageableSessions: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../instance/cross-session-messaging', () => ({
  getCrossSessionMessagingService: () => ({
    sendMessage: mocks.sendMessage,
    listMessageableSessions: mocks.listMessageableSessions,
  }),
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerInstanceCrossSessionMessagingHandlers } from '../instance-cross-session-messaging-handlers';

describe('registerInstanceCrossSessionMessagingHandlers', () => {
  const setAllowIncomingSessionMessages = vi.fn();
  const getInstance = vi.fn();
  const serializeForIpc = vi.fn((instance: unknown) => instance);
  const instanceManager = {
    setAllowIncomingSessionMessages,
    getInstance,
    serializeForIpc,
  } as unknown as InstanceManager;

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.sendMessage.mockReset();
    mocks.listMessageableSessions.mockReset();
    setAllowIncomingSessionMessages.mockReset();
    getInstance.mockReset();
    serializeForIpc.mockClear();
    registerInstanceCrossSessionMessagingHandlers(instanceManager);
  });

  describe(IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE, () => {
    it('validates the payload and returns the discriminated result as data, even for a rejection', async () => {
      mocks.sendMessage.mockResolvedValue({ outcome: 'rejected', reason: 'consent-disabled' });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE)!;

      const response = await handler({}, {
        sourceInstanceId: 'src',
        targetNameOrId: 'tgt',
        message: 'hello',
      });

      expect(mocks.sendMessage).toHaveBeenCalledWith({
        sourceInstanceId: 'src',
        targetNameOrId: 'tgt',
        message: 'hello',
      });
      expect(response).toEqual({ success: true, data: { outcome: 'rejected', reason: 'consent-disabled' } });
    });

    it('rejects a missing message before calling the service', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE)!;
      const response = await handler({}, { sourceInstanceId: 'src', targetNameOrId: 'tgt' });
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('CROSS_SESSION_MESSAGE_SEND_FAILED');
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects an oversized message before calling the service', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE)!;
      const response = await handler({}, {
        sourceInstanceId: 'src',
        targetNameOrId: 'tgt',
        message: 'x'.repeat(10_001),
      });
      expect(response.success).toBe(false);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('surfaces a thrown error from the service as a structured failure response', async () => {
      mocks.sendMessage.mockRejectedValue(new Error('source not found'));
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_SEND_CROSS_SESSION_MESSAGE)!;
      const response = await handler({}, { sourceInstanceId: 'src', targetNameOrId: 'tgt', message: 'hi' });
      expect(response).toEqual({
        success: false,
        error: {
          code: 'CROSS_SESSION_MESSAGE_SEND_FAILED',
          message: 'source not found',
          timestamp: expect.any(Number),
        },
      });
    });
  });

  describe(IPC_CHANNELS.INSTANCE_LIST_MESSAGEABLE_SESSIONS, () => {
    it('validates and forwards sourceInstanceId', async () => {
      mocks.listMessageableSessions.mockReturnValue([
        { instanceId: 'tgt', displayName: 'Target', reachable: true, reason: 'reachable' },
      ]);
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_LIST_MESSAGEABLE_SESSIONS)!;

      const response = await handler({}, { sourceInstanceId: 'src' });

      expect(mocks.listMessageableSessions).toHaveBeenCalledWith('src');
      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(1);
    });

    it('rejects a missing sourceInstanceId', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_LIST_MESSAGEABLE_SESSIONS)!;
      const response = await handler({}, {});
      expect(response.success).toBe(false);
      expect(mocks.listMessageableSessions).not.toHaveBeenCalled();
    });
  });

  describe(IPC_CHANNELS.INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES, () => {
    it('toggles consent and returns the updated serialized instance', async () => {
      getInstance.mockReturnValue({ id: 'inst-1', allowIncomingSessionMessages: true });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES)!;

      const response = await handler({}, { instanceId: 'inst-1', allow: true });

      expect(setAllowIncomingSessionMessages).toHaveBeenCalledWith('inst-1', true);
      expect(response.success).toBe(true);
      expect(serializeForIpc).toHaveBeenCalledWith({ id: 'inst-1', allowIncomingSessionMessages: true });
    });

    it('returns undefined data when the instance no longer exists', async () => {
      getInstance.mockReturnValue(undefined);
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES)!;

      const response = await handler({}, { instanceId: 'gone', allow: false });

      expect(response).toEqual({ success: true, data: undefined });
    });

    it('rejects a missing instanceId', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_TOGGLE_ALLOW_INCOMING_SESSION_MESSAGES)!;
      const response = await handler({}, { allow: true });
      expect(response.success).toBe(false);
      expect(setAllowIncomingSessionMessages).not.toHaveBeenCalled();
    });
  });
});
