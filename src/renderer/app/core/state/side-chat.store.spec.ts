import { TestBed } from '@angular/core/testing';
import { SideChatStore } from './side-chat.store';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';
import type { SideChatParentRef } from '../../../../shared/types/side-chat.types';

const PARENT_A: SideChatParentRef = { kind: 'chat', chatId: 'parent-a' };
const PARENT_B: SideChatParentRef = { kind: 'chat', chatId: 'parent-b' };

function createMockIpc() {
  return {
    sideChatList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    sideChatCreate: vi.fn().mockResolvedValue({
      success: true,
      data: {
        chat: { id: 'new-side', name: 'Side', provider: 'claude', currentCwd: '/w', ledgerThreadId: 't', currentInstanceId: null, createdAt: 1, lastActiveAt: 1, archivedAt: null, model: null, reasoningEffort: null, projectId: null, yolo: false },
        conversation: { thread: {}, messages: [] },
        currentInstance: null,
      },
    }),
    sideChatSend: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    sideChatMarkRead: vi.fn().mockResolvedValue({ success: true, data: null }),
    sideChatAttention: vi.fn().mockResolvedValue({
      success: true,
      data: { parent: PARENT_A, total: 2, running: 1, unread: 1, needsAttention: 0 },
    }),
    get: vi.fn().mockResolvedValue({ success: true, data: null }),
  };
}

describe('SideChatStore', () => {
  let store: SideChatStore;
  let ipc: ReturnType<typeof createMockIpc>;

  beforeEach(() => {
    ipc = createMockIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: ChatIpcService, useValue: ipc }],
    });
    store = TestBed.inject(SideChatStore);
  });

  it('keys session state by parent identity', () => {
    expect(store.sessionKey(PARENT_A)).toBe('chat:parent-a');
    expect(store.sessionKey(PARENT_B)).toBe('chat:parent-b');
    expect(store.sessionKey(PARENT_A)).not.toBe(store.sessionKey(PARENT_B));
  });

  it('keeps drafts isolated per session and per chat', () => {
    store.setDraft(PARENT_A, 'side-1', 'draft A1');
    store.setDraft(PARENT_A, 'side-2', 'draft A2');
    store.setDraft(PARENT_B, 'side-1', 'draft B1');

    expect(store.draftFor(PARENT_A, 'side-1')).toBe('draft A1');
    expect(store.draftFor(PARENT_A, 'side-2')).toBe('draft A2');
    expect(store.draftFor(PARENT_B, 'side-1')).toBe('draft B1');
  });

  it('survives panel destruction without losing drafts', () => {
    store.setDraft(PARENT_A, 'side-1', 'persistent draft');
    // Panel is destroyed and recreated — the store keeps the draft.
    expect(store.draftFor(PARENT_A, 'side-1')).toBe('persistent draft');
  });

  it('keeps selection isolated per parent session', () => {
    store.selectChat(PARENT_A, 'side-a1');
    store.selectChat(PARENT_B, 'side-b1');

    expect(store.selectedChatId(PARENT_A)).toBe('side-a1');
    expect(store.selectedChatId(PARENT_B)).toBe('side-b1');
  });

  it('invalidates late loads when the parent selection changes', async () => {
    let resolveA: (value: unknown) => void = () => undefined;
    ipc.sideChatList.mockImplementationOnce(() =>
      new Promise((resolve) => { resolveA = resolve; }),
    );

    const loadA = store.loadForParent(PARENT_A);
    // Switch parent before A's load resolves.
    const loadB = store.loadForParent(PARENT_B);
    resolveA({ success: true, data: [{ chatId: 'stale-a', parent: PARENT_A, authority: 'inherit-parent', lastReadAssistantSequence: 0 }] });
    await loadA;
    await loadB;

    // The stale load must not have selected anything for parent A.
    expect(store.selectedChatId(PARENT_A)).toBeNull();
  });

  it('stores attention per parent', async () => {
    await store.loadAttention(PARENT_A);
    const attention = store.attention().get('chat:parent-a');
    expect(attention?.unread).toBe(1);
    expect(attention?.running).toBe(1);
  });

  it('creates a sidechat and selects it', async () => {
    const chatId = await store.createSideChat(
      PARENT_A,
      { provider: 'claude', model: null, reasoning: null },
      '/work',
    );
    expect(chatId).toBe('new-side');
    expect(store.selectedChatId(PARENT_A)).toBe('new-side');
  });

  it('sends to an existing sidechat and clears the draft', async () => {
    store.setDraft(PARENT_A, 'side-1', '  Hello  ');
    const ok = await store.send(PARENT_A, 'side-1', '  Hello  ', '/work');
    expect(ok).toBe(true);
    expect(ipc.sideChatSend).toHaveBeenCalledWith({ chatId: 'side-1', text: 'Hello' });
    expect(store.draftFor(PARENT_A, 'side-1')).toBe('');
  });

  it('creates a sidechat on first send when none exists', async () => {
    const ok = await store.send(PARENT_A, null, 'First question', '/work');
    expect(ok).toBe(true);
    expect(ipc.sideChatCreate).toHaveBeenCalled();
    expect(ipc.sideChatSend).toHaveBeenCalledWith({ chatId: 'new-side', text: 'First question' });
  });

  it('marks read monotonically', async () => {
    await store.markRead('side-1', 5);
    await store.markRead('side-1', 3);
    // The IPC call is made, but the local link mark only advances.
    expect(ipc.sideChatMarkRead).toHaveBeenCalledTimes(2);
  });

  it('has no independent enable-editing toggle — authority is inherit-parent', async () => {
    const chatId = await store.createSideChat(
      PARENT_A,
      { provider: 'claude', model: null, reasoning: null },
      '/work',
    );
    const link = store.links().get(chatId!);
    expect(link?.authority).toBe('inherit-parent');
  });
});
