import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<IpcResponse>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<IpcResponse>) => {
      electronMocks.handlers.set(channel, handler);
    },
  },
}));

const sideChats = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  listArchived: vi.fn(),
  send: vi.fn(),
  markRead: vi.fn(),
  attention: vi.fn(),
  attentionForAll: vi.fn(),
  setSelection: vi.fn(),
  attach: vi.fn(),
  permissions: vi.fn(),
}));
vi.mock('../../../chats', () => ({
  getChatService: () => ({
    initialize: vi.fn(),
    events: { on: vi.fn() },
    sideChats,
  }),
}));
vi.mock('../../../event-bus/main-event-bus', () => ({
  getMainEventBus: () => ({ emitRendererEvent: vi.fn() }),
}));
vi.mock('../../../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));

import { SideChatError } from '../../../chats/side-chat-service';
import { registerChatHandlers } from '../chat-handlers';

const parent = { kind: 'session', historyThreadId: 'thread-1', originNodeId: null };

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, payload);
}

describe('sidechat IPC handlers', () => {
  beforeAll(() => {
    registerChatHandlers({ instanceManager: {} as never });
  });

  beforeEach(() => {
    for (const mock of Object.values(sideChats)) mock.mockReset();
  });

  it('registers every sidechat channel', () => {
    const sideChannels = Object.entries(IPC_CHANNELS)
      .filter(([key]) => key.startsWith('SIDE_CHAT_'))
      .map(([, value]) => value);
    expect(sideChannels.length).toBeGreaterThanOrEqual(9);
    for (const channel of sideChannels) {
      expect(electronMocks.handlers.has(channel), channel).toBe(true);
    }
  });

  it('creates with the picker selection, keeping "provider default" reasoning distinct from null', async () => {
    sideChats.create.mockResolvedValue({ chat: { id: 'side-1' } });

    const response = await invoke(IPC_CHANNELS.SIDE_CHAT_CREATE, {
      parent, selection: { provider: 'grok', model: 'grok-4' }, currentCwd: '/work',
    });

    expect(response.success).toBe(true);
    expect(sideChats.create).toHaveBeenCalledWith({
      parent,
      name: undefined,
      currentCwd: '/work',
      selection: { provider: 'grok', model: 'grok-4', reasoning: undefined, modelRuntimeTarget: null },
    });
  });

  it('rejects malformed payloads before reaching the service', async () => {
    const response = await invoke(IPC_CHANNELS.SIDE_CHAT_MARK_READ, { chatId: 'side-1', throughSequence: -2 });

    expect(response.success).toBe(false);
    expect(sideChats.markRead).not.toHaveBeenCalled();
  });

  it('returns active and archived conversations for a parent', async () => {
    sideChats.list.mockResolvedValue([{ chat: { id: 'a' } }]);
    sideChats.listArchived.mockReturnValue([{ id: 'old' }]);

    const response = await invoke(IPC_CHANNELS.SIDE_CHAT_LIST, { parent });

    expect(response).toMatchObject({ success: true, data: { active: [{ chat: { id: 'a' } }], archived: [{ id: 'old' }] } });
  });

  it('surfaces a refused send with its stable code and the snapshot hint', async () => {
    sideChats.send.mockResolvedValue({
      ok: false, code: 'parent-unavailable', error: 'Parent gone', lastSnapshotAvailable: true,
    });

    const response = await invoke(IPC_CHANNELS.SIDE_CHAT_SEND, { chatId: 'side-1', text: 'Hi' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'SIDE_CHAT_PARENT_UNAVAILABLE', message: 'Parent gone' },
      data: { lastSnapshotAvailable: true },
    });
  });

  it('maps a refused operation to its sidechat error code', async () => {
    sideChats.setSelection.mockRejectedValue(new SideChatError('busy', 'Stop the current answer first'));

    const response = await invoke(IPC_CHANNELS.SIDE_CHAT_SET_SELECTION, {
      chatId: 'side-1', selection: { provider: 'codex' },
    });

    expect(response).toMatchObject({ success: false, error: { code: 'SIDE_CHAT_BUSY', message: 'Stop the current answer first' } });
  });

  it('routes attach, permissions and global attention', async () => {
    sideChats.attach.mockResolvedValue({ chat: { id: 'c1' } });
    sideChats.permissions.mockResolvedValue({ ok: true, providers: [] });
    sideChats.attentionForAll.mockResolvedValue([]);

    expect((await invoke(IPC_CHANNELS.SIDE_CHAT_ATTACH, { chatId: 'c1', parent })).success).toBe(true);
    expect(sideChats.attach).toHaveBeenCalledWith('c1', parent);
    expect((await invoke(IPC_CHANNELS.SIDE_CHAT_PERMISSIONS, { parent })).success).toBe(true);
    expect((await invoke(IPC_CHANNELS.SIDE_CHAT_ATTENTION_ALL)).success).toBe(true);
  });
});
