import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createChatDomain } from '../domains/chat.preload';

describe('chat preload domain', () => {
  it('exposes every chat command on the expected contract channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createChatDomain(ipcRenderer, IPC_CHANNELS);

    await domain.chatList({ includeArchived: true });
    await domain.chatGet({ chatId: 'chat-1' });
    await domain.chatCreate({ provider: 'claude', currentCwd: '/work' });
    await domain.chatRename({ chatId: 'chat-1', name: 'Renamed' });
    await domain.chatArchive({ chatId: 'chat-1' });
    await domain.chatSetCwd({ chatId: 'chat-1', cwd: '/next' });
    await domain.chatSetProvider({ chatId: 'chat-1', provider: 'codex' });
    await domain.chatSetModel({ chatId: 'chat-1', model: null });
    await domain.chatSetReasoning({ chatId: 'chat-1', reasoningEffort: 'high' });
    await domain.chatSetYolo({ chatId: 'chat-1', yolo: true });
    await domain.chatSendMessage({ chatId: 'chat-1', text: 'Hello' });

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.CHAT_LIST, { includeArchived: true });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.CHAT_GET, { chatId: 'chat-1' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.CHAT_CREATE, { provider: 'claude', currentCwd: '/work' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(4, IPC_CHANNELS.CHAT_RENAME, { chatId: 'chat-1', name: 'Renamed' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(5, IPC_CHANNELS.CHAT_ARCHIVE, { chatId: 'chat-1' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(6, IPC_CHANNELS.CHAT_SET_CWD, { chatId: 'chat-1', cwd: '/next' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(7, IPC_CHANNELS.CHAT_SET_PROVIDER, { chatId: 'chat-1', provider: 'codex' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(8, IPC_CHANNELS.CHAT_SET_MODEL, { chatId: 'chat-1', model: null });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(9, IPC_CHANNELS.CHAT_SET_REASONING, { chatId: 'chat-1', reasoningEffort: 'high' });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(10, IPC_CHANNELS.CHAT_SET_YOLO, { chatId: 'chat-1', yolo: true });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(11, IPC_CHANNELS.CHAT_SEND_MESSAGE, { chatId: 'chat-1', text: 'Hello' });
  });

  it('subscribes and unsubscribes chat events using the contract channel', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createChatDomain(ipcRenderer, IPC_CHANNELS);
    const unsubscribe = domain.onChatEvent(vi.fn());

    expect(ipcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_EVENT, expect.any(Function));
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_EVENT, expect.any(Function));
  });
});
