import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDetail, ChatEvent, ChatRecord } from '../../../../shared/types/chat.types';
import type { ConversationThreadRecord } from '../../../../shared/types/conversation-ledger.types';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';
import { ChatStore } from './chat.store';

describe('ChatStore', () => {
  let chatEventHandler: ((event: ChatEvent) => void) | null;

  const ipc = {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    setCwd: vi.fn(),
    setProvider: vi.fn(),
    setModel: vi.fn(),
    setReasoning: vi.fn(),
    setYolo: vi.fn(),
    sendMessage: vi.fn(),
    onChatEvent: vi.fn((handler: (event: ChatEvent) => void) => {
      chatEventHandler = handler;
      return () => {
        chatEventHandler = null;
      };
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chatEventHandler = null;
    ipc.list.mockResolvedValue({ success: true, data: [chatRecord('chat-1'), chatRecord('chat-2')] });
    ipc.get.mockImplementation(async (chatId: string) => ({
      success: true,
      data: chatDetail(chatRecord(chatId)),
    }));

    TestBed.configureTestingModule({
      providers: [
        ChatStore,
        { provide: ChatIpcService, useValue: ipc },
      ],
    });
  });

  it('clears selected archived chats when an external archive event arrives', async () => {
    const store = TestBed.inject(ChatStore);

    await store.initialize();
    await store.select('chat-1');
    chatEventHandler?.({ type: 'chat-archived', chatId: 'chat-1' });

    expect(store.chats().map((chat) => chat.id)).toEqual(['chat-2']);
    expect(store.selectedChatId()).toBeNull();
    expect(store.selectedDetail()).toBeNull();
  });
});

function chatRecord(id: string): ChatRecord {
  return {
    id,
    name: id === 'chat-1' ? 'First chat' : 'Second chat',
    provider: 'claude',
    model: null,
    reasoningEffort: null,
    currentCwd: `/work/${id}`,
    projectId: null,
    yolo: false,
    ledgerThreadId: `thread-${id}`,
    currentInstanceId: null,
    createdAt: id === 'chat-1' ? 1 : 2,
    lastActiveAt: id === 'chat-1' ? 20 : 10,
    archivedAt: null,
  };
}

function chatDetail(chat: ChatRecord): ChatDetail {
  return {
    chat,
    conversation: {
      thread: {
        id: chat.ledgerThreadId,
        provider: 'orchestrator',
        nativeThreadId: `orchestrator-${chat.id}`,
        nativeSessionId: `orchestrator-${chat.id}`,
        nativeSourceKind: 'internal',
        sourceKind: 'orchestrator',
        sourcePath: null,
        workspacePath: chat.currentCwd,
        title: chat.name,
        createdAt: chat.createdAt,
        updatedAt: chat.lastActiveAt,
        lastSyncedAt: null,
        writable: true,
        nativeVisibilityMode: 'none',
        syncStatus: 'synced',
        conflictStatus: 'none',
        parentConversationId: null,
        metadata: { chatId: chat.id },
      } satisfies ConversationThreadRecord,
      messages: [],
    },
    currentInstance: null,
  };
}
