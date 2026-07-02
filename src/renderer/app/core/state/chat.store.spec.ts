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
    loadOlderMessages: vi.fn(),
    sendMessage: vi.fn(),
    getUiState: vi.fn(),
    setUiState: vi.fn(),
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
    ipc.getUiState.mockResolvedValue({
      success: true,
      data: { selectedChatId: null, openChatIds: [], updatedAt: 0 },
    });
    ipc.setUiState.mockResolvedValue({
      success: true,
      data: { selectedChatId: null, openChatIds: [], updatedAt: 0 },
    });
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

  it('preserves already-loaded older chat messages when a fresh tail detail replaces the cache', async () => {
    const store = TestBed.inject(ChatStore);
    const base = chatDetail(chatRecord('chat-1'));
    base.conversation.messages = [messageRecord('m1', 1), messageRecord('m2', 2), messageRecord('m3', 3)];
    base.conversation.window = {
      totalMessages: 3,
      hasOlder: false,
      oldestSequence: 1,
      newestSequence: 3,
    };
    ipc.get.mockResolvedValueOnce({ success: true, data: base });

    await store.initialize();
    await store.select('chat-1');

    const tailOnly = chatDetail(chatRecord('chat-1'));
    tailOnly.conversation.messages = [messageRecord('m2', 2), messageRecord('m3', 3)];
    tailOnly.conversation.window = {
      totalMessages: 3,
      hasOlder: true,
      oldestSequence: 2,
      newestSequence: 3,
    };
    ipc.rename.mockResolvedValueOnce({ success: true, data: tailOnly });

    await store.rename('chat-1', 'Renamed');

    expect(store.selectedDetail()?.conversation.messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
    expect(store.selectedDetail()?.conversation.window).toMatchObject({
      totalMessages: 3,
      hasOlder: false,
      oldestSequence: 1,
      newestSequence: 3,
    });
  });

  it('prepends older messages into the selected chat detail', async () => {
    const store = TestBed.inject(ChatStore);
    const base = chatDetail(chatRecord('chat-1'));
    base.conversation.messages = [messageRecord('m3', 3), messageRecord('m4', 4)];
    base.conversation.window = {
      totalMessages: 4,
      hasOlder: true,
      oldestSequence: 3,
      newestSequence: 4,
    };
    ipc.get.mockResolvedValueOnce({ success: true, data: base });
    ipc.loadOlderMessages.mockResolvedValueOnce({
      success: true,
      data: {
        threadId: 'thread-chat-1',
        messages: [messageRecord('m1', 1), messageRecord('m2', 2)],
        totalMessages: 4,
        hasMore: false,
        nextBeforeSequence: 1,
      },
    });

    await store.initialize();
    await store.select('chat-1');
    const result = await store.loadOlderMessages();

    expect(result).toEqual({
      prependedCount: 2,
      hasMore: false,
      totalStored: 4,
    });
    expect(store.selectedDetail()?.conversation.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(store.selectedDetail()?.conversation.window).toMatchObject({
      totalMessages: 4,
      hasOlder: false,
      oldestSequence: 1,
      newestSequence: 4,
    });
  });

  it('restores the last selected chat during initialization after an app crash', async () => {
    ipc.getUiState.mockResolvedValueOnce({
      success: true,
      data: {
        selectedChatId: 'chat-2',
        openChatIds: ['chat-1', 'chat-2'],
        updatedAt: 1234,
      },
    });
    const store = TestBed.inject(ChatStore);

    await store.initialize();

    expect(store.selectedChatId()).toBe('chat-2');
    expect(ipc.get).toHaveBeenCalledWith('chat-2');
    expect(store.selectedDetail()?.chat.id).toBe('chat-2');
  });

  it('creates a detached chat without selecting it or persisting UI state', async () => {
    const store = TestBed.inject(ChatStore);
    await store.initialize();
    await store.select('chat-1');
    ipc.setUiState.mockClear();

    const created = chatDetail(chatRecord('chat-9'));
    ipc.create.mockResolvedValueOnce({ success: true, data: created });

    const result = await store.createDetached({
      name: 'Side chat',
      provider: 'claude',
      currentCwd: '/work/chat-9',
    });

    expect(result).toEqual({ ok: true, detail: created });
    expect(store.selectedChatId()).toBe('chat-1');
    expect(ipc.setUiState).not.toHaveBeenCalled();
    expect(store.details().get('chat-9')?.chat.id).toBe('chat-9');
    expect(store.chats().some((chat) => chat.id === 'chat-9')).toBe(true);
  });

  it('sends to an explicit chat without touching global sending/error state', async () => {
    const store = TestBed.inject(ChatStore);
    await store.initialize();
    await store.select('chat-1');

    ipc.sendMessage.mockResolvedValueOnce({
      success: false,
      error: { message: 'provider offline' },
    });

    const result = await store.sendMessageTo('chat-2', 'hello');

    expect(result).toEqual({ ok: false, error: 'provider offline' });
    expect(ipc.sendMessage).toHaveBeenCalledWith('chat-2', 'hello', undefined);
    // The failure belongs to the caller (side-chat panel), not the main view.
    expect(store.error()).toBeNull();
    expect(store.sending()).toBe(false);
  });

  it('quietly refreshes a cached background chat detail on runtime events', async () => {
    const store = TestBed.inject(ChatStore);
    await store.initialize();
    await store.select('chat-1');
    await store.ensureDetailLoaded('chat-2');
    ipc.get.mockClear();

    chatEventHandler?.({
      type: 'runtime-linked',
      chatId: 'chat-2',
      instanceId: 'inst-1',
      chat: chatRecord('chat-2'),
    });
    await vi.waitFor(() => {
      expect(ipc.get).toHaveBeenCalledWith('chat-2');
    });

    // Global loading stayed off for the background refresh path.
    expect(store.loading()).toBe(false);
    expect(store.selectedChatId()).toBe('chat-1');
  });

  it('loads older messages for a non-selected chat', async () => {
    const store = TestBed.inject(ChatStore);
    const background = chatDetail(chatRecord('chat-2'));
    background.conversation.messages = [messageRecord('m3', 3)];
    background.conversation.window = {
      totalMessages: 2,
      hasOlder: true,
      oldestSequence: 3,
      newestSequence: 3,
    };
    ipc.get.mockImplementation(async (chatId: string) => ({
      success: true,
      data: chatId === 'chat-2' ? background : chatDetail(chatRecord(chatId)),
    }));
    ipc.loadOlderMessages.mockResolvedValueOnce({
      success: true,
      data: {
        threadId: 'thread-chat-2',
        messages: [messageRecord('m1', 1)],
        totalMessages: 2,
        hasMore: false,
        nextBeforeSequence: 1,
      },
    });

    await store.initialize();
    await store.select('chat-1');
    await store.ensureDetailLoaded('chat-2');

    const result = await store.loadOlderMessagesFor('chat-2');

    expect(result).toEqual({ prependedCount: 1, hasMore: false, totalStored: 2 });
    expect(ipc.loadOlderMessages).toHaveBeenCalledWith('chat-2', 3, 200);
    expect(store.details().get('chat-2')?.conversation.messages.map((m) => m.sequence)).toEqual([1, 3]);
  });

  it('persists selected and deselected chat UI state through IPC', async () => {
    const store = TestBed.inject(ChatStore);

    await store.initialize();
    await store.select('chat-1');
    store.deselect();

    expect(ipc.setUiState).toHaveBeenNthCalledWith(1, {
      selectedChatId: 'chat-1',
      openChatIds: ['chat-1'],
    });
    expect(ipc.setUiState).toHaveBeenNthCalledWith(2, {
      selectedChatId: null,
      openChatIds: [],
    });
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
      window: {
        totalMessages: 0,
        hasOlder: false,
        oldestSequence: null,
        newestSequence: null,
      },
    },
    currentInstance: null,
  };
}
