import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { ChatIpcService } from './chat-ipc.service';

describe('ChatIpcService', () => {
  const api = {
    chatList: vi.fn(),
    chatGet: vi.fn(),
    chatCreate: vi.fn(),
    chatRename: vi.fn(),
    chatArchive: vi.fn(),
    chatSetCwd: vi.fn(),
    chatSetProvider: vi.fn(),
    chatSetModel: vi.fn(),
    chatSetReasoning: vi.fn(),
    chatSetYolo: vi.fn(),
    chatSendMessage: vi.fn(),
    onChatEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of [
      api.chatList,
      api.chatGet,
      api.chatCreate,
      api.chatRename,
      api.chatArchive,
      api.chatSetCwd,
      api.chatSetProvider,
      api.chatSetModel,
      api.chatSetReasoning,
      api.chatSetYolo,
      api.chatSendMessage,
    ]) {
      method.mockResolvedValue({ success: true });
    }
    api.onChatEvent.mockReturnValue(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        ChatIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            getApi: () => api,
            getNgZone: () => ({ run: (fn: () => void) => fn() }),
          },
        },
      ],
    });
  });

  it('delegates every chat command to the preload chat domain', async () => {
    const service = TestBed.inject(ChatIpcService);

    await service.list({ includeArchived: true });
    await service.get('chat-1');
    await service.create({ provider: 'claude', currentCwd: '/work' });
    await service.rename('chat-1', 'Renamed');
    await service.archive('chat-1');
    await service.setCwd('chat-1', '/next');
    await service.setProvider('chat-1', 'codex');
    await service.setModel('chat-1', null);
    await service.setReasoning('chat-1', 'high');
    await service.setYolo('chat-1', true);
    await service.sendMessage('chat-1', 'Hello');

    expect(api.chatList).toHaveBeenCalledWith({ includeArchived: true });
    expect(api.chatGet).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(api.chatCreate).toHaveBeenCalledWith({ provider: 'claude', currentCwd: '/work' });
    expect(api.chatRename).toHaveBeenCalledWith({ chatId: 'chat-1', name: 'Renamed' });
    expect(api.chatArchive).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(api.chatSetCwd).toHaveBeenCalledWith({ chatId: 'chat-1', cwd: '/next' });
    expect(api.chatSetProvider).toHaveBeenCalledWith({ chatId: 'chat-1', provider: 'codex' });
    expect(api.chatSetModel).toHaveBeenCalledWith({ chatId: 'chat-1', model: null });
    expect(api.chatSetReasoning).toHaveBeenCalledWith({ chatId: 'chat-1', reasoningEffort: 'high' });
    expect(api.chatSetYolo).toHaveBeenCalledWith({ chatId: 'chat-1', yolo: true });
    expect(api.chatSendMessage).toHaveBeenCalledWith({ chatId: 'chat-1', text: 'Hello', attachments: undefined });
  });

  it('runs chat event callbacks inside Angular zone', () => {
    const service = TestBed.inject(ChatIpcService);
    const callback = vi.fn();

    service.onChatEvent(callback);
    const forwarded = api.onChatEvent.mock.calls[0][0] as (payload: unknown) => void;
    forwarded({ type: 'chat-archived', chatId: 'chat-1' });

    expect(callback).toHaveBeenCalledWith({ type: 'chat-archived', chatId: 'chat-1' });
  });
});
