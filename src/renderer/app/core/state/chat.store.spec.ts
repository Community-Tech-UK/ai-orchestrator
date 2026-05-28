import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDetail, ChatEvent, ChatRecord } from '../../../../shared/types/chat.types';
import type { ConversationMessageRecord, ConversationThreadRecord } from '../../../../shared/types/conversation-ledger.types';
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

  it('merges a transcript-appended delta, preserving prior message identity', async () => {
    const store = TestBed.inject(ChatStore);
    const base = chatDetail(chatRecord('chat-1'));
    const priorMessage = messageRecord('m1', 1);
    base.conversation.messages = [priorMessage];
    ipc.get.mockResolvedValueOnce({ success: true, data: base });

    await store.initialize();
    await store.select('chat-1');

    const appended = messageRecord('m2', 2);
    chatEventHandler?.({
      type: 'transcript-appended',
      chatId: 'chat-1',
      chat: chatRecord('chat-1'),
      messages: [appended],
      currentInstance: null,
    });

    const detail = store.selectedDetail();
    expect(detail?.conversation.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    // Prior record keeps its object identity so the renderer's incremental
    // display pipeline stays on its fast path.
    expect(detail?.conversation.messages[0]).toBe(priorMessage);
    expect(detail?.conversation.messages[1]).toBe(appended);
  });

  it('does not cache a transcript for a background chat with no loaded base', async () => {
    const store = TestBed.inject(ChatStore);
    await store.initialize();

    chatEventHandler?.({
      type: 'transcript-appended',
      chatId: 'chat-9',
      chat: chatRecord('chat-9'),
      messages: [messageRecord('m1', 1)],
      currentInstance: null,
    });

    // Not selected and never loaded → no detail materialized (lazy hydrate).
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

function messageRecord(id: string, sequence: number): ConversationMessageRecord {
  return {
    id,
    threadId: 'thread-chat-1',
    nativeMessageId: id,
    nativeTurnId: null,
    role: 'assistant',
    phase: null,
    content: `content ${id}`,
    createdAt: sequence,
    tokenInput: null,
    tokenOutput: null,
    rawRef: null,
    rawJson: null,
    sourceChecksum: null,
    sequence,
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
