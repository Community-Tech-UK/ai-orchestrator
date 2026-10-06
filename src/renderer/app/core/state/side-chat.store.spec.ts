import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatStore } from './side-chat.store';
import { ChatStore } from './chat.store';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';
import type { ChatEvent, ChatRecord } from '../../../../shared/types/chat.types';
import type { SideChatAttention, SideChatParentRef, SideChatSummary } from '../../../../shared/types/side-chat.types';

const PARENT_A: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-a', originNodeId: null };
const PARENT_B: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-b', originNodeId: null };

function chat(id: string): ChatRecord {
  return {
    id, name: `Chat ${id}`, provider: 'claude', model: null, reasoningEffort: null, currentCwd: '/work',
    projectId: null, yolo: false, ledgerThreadId: `t-${id}`, currentInstanceId: null,
    createdAt: 1, lastActiveAt: 1, archivedAt: null,
  };
}

function summary(id: string, parent: SideChatParentRef, state: SideChatSummary['state'] = 'idle', read = 0, latest = 0): SideChatSummary {
  return {
    link: { chatId: id, parent, authority: 'inherit-parent', lastReadAssistantSequence: read },
    chat: chat(id), status: null, latestAssistantSequence: latest, state,
  };
}

function attention(parent: SideChatParentRef, overrides: Partial<SideChatAttention> = {}): SideChatAttention {
  return { parent, parentTitle: 'Session', total: 1, running: 0, unread: 0, needsAttention: 0, targetChatId: null, ...overrides };
}

describe('SideChatStore', () => {
  let store: SideChatStore;
  let emit: (event: ChatEvent) => void;
  let ipc: Record<string, ReturnType<typeof vi.fn>>;
  let chatStore: { ensureDetailLoaded: ReturnType<typeof vi.fn>; archive: ReturnType<typeof vi.fn>; details: ReturnType<typeof signal> };

  beforeEach(() => {
    ipc = {
      onChatEvent: vi.fn((callback: (event: ChatEvent) => void) => { emit = callback; return () => undefined; }),
      sideChatAttentionAll: vi.fn().mockResolvedValue({ success: true, data: [attention(PARENT_A, { unread: 2 })] }),
      sideChatList: vi.fn().mockResolvedValue({ success: true, data: { active: [], archived: [] } }),
      sideChatPermissions: vi.fn().mockResolvedValue({ success: true, data: { ok: true, providers: [] } }),
      sideChatCreate: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('new-side') } }),
      sideChatSend: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      sideChatMarkRead: vi.fn(async ({ chatId, throughSequence }: { chatId: string; throughSequence: number }) => ({
        success: true,
        data: { chatId, parent: PARENT_A, authority: 'inherit-parent', lastReadAssistantSequence: throughSequence },
      })),
      sideChatSetSelection: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('s1') } }),
      sideChatAttach: vi.fn().mockResolvedValue({ success: true, data: { chat: chat('loose') } }),
    };
    chatStore = { ensureDetailLoaded: vi.fn().mockResolvedValue(undefined), archive: vi.fn().mockResolvedValue(undefined), details: signal(new Map()) };
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatIpcService, useValue: ipc },
        { provide: ChatStore, useValue: chatStore },
      ],
    });
    store = TestBed.inject(SideChatStore);
  });

  afterEach(() => store.disposeForTesting());

  it('loads attention for every parent and applies coalesced deltas without a panel', async () => {
    await store.initialize();
    expect(store.attentionFor(PARENT_A)?.unread).toBe(2);
    expect(store.attentionBadgeCount()).toBe(2);

    emit({ type: 'side-chat-attention', attention: attention(PARENT_B, { needsAttention: 1, targetChatId: 'b1' }) });

    expect(store.attentionBadgeCount()).toBe(3);
    expect(store.attentionList()[0]?.parent).toEqual(PARENT_B);
    expect(ipc['sideChatList']).not.toHaveBeenCalled();
  });

  it('keeps drafts, selection and pending provider per parent, surviving panel destruction', () => {
    store.setDraft(PARENT_A, null, 'new question for A');
    store.setDraft(PARENT_A, 's1', 'follow-up for s1');
    store.setDraft(PARENT_B, null, 'new question for B');
    store.selectChat(PARENT_A, 's1');
    store.setPendingSelection(PARENT_B, { provider: 'codex', model: 'gpt-5.5' });

    expect(store.draftFor(PARENT_A, null)).toBe('new question for A');
    expect(store.draftFor(PARENT_A, 's1')).toBe('follow-up for s1');
    expect(store.draftFor(PARENT_B, null)).toBe('new question for B');
    expect(store.selectedChatId(PARENT_A)).toBe('s1');
    expect(store.selectedChatId(PARENT_B)).toBeNull();
    expect(store.pendingSelection(PARENT_A)).toBeNull();
    expect(chatStore.ensureDetailLoaded).toHaveBeenCalledWith('s1');
  });

  it('opens on the conversation that needs action, else the last selected one', async () => {
    ipc['sideChatList'].mockResolvedValue({
      success: true,
      data: { active: [summary('s1', PARENT_A), summary('s2', PARENT_A, 'unread', 0, 4), summary('s3', PARENT_A)], archived: [] },
    });
    store.selectChat(PARENT_A, 's3');

    await store.open(PARENT_A);
    expect(store.selectedChatId(PARENT_A)).toBe('s2');

    ipc['sideChatList'].mockResolvedValue({
      success: true, data: { active: [summary('s1', PARENT_A), summary('s3', PARENT_A)], archived: [] },
    });
    store.selectChat(PARENT_A, 's1');
    await store.open(PARENT_A);
    expect(store.selectedChatId(PARENT_A)).toBe('s1');

    await store.open(PARENT_A, 's3');
    expect(store.selectedChatId(PARENT_A)).toBe('s3');
  });

  it('drops a late list response superseded by a newer load of the same parent', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    ipc['sideChatList']
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, data: { active: [summary('fresh', PARENT_A)], archived: [] } });

    const first = store.refresh(PARENT_A);
    await store.refresh(PARENT_A);
    resolveFirst({ success: true, data: { active: [summary('stale', PARENT_A)], archived: [] } });
    await first;

    expect(store.summariesFor(PARENT_A).map((item) => item.chat.id)).toEqual(['fresh']);
  });

  it('never lets one parent\'s list overwrite another\'s', async () => {
    ipc['sideChatList'].mockImplementation(async ({ parent }: { parent: SideChatParentRef }) => ({
      success: true,
      data: { active: [summary(parent === PARENT_A ? 'a1' : 'b1', parent)], archived: [] },
    }));

    await Promise.all([store.open(PARENT_A), store.open(PARENT_B)]);

    expect(store.summariesFor(PARENT_A).map((item) => item.chat.id)).toEqual(['a1']);
    expect(store.summariesFor(PARENT_B).map((item) => item.chat.id)).toEqual(['b1']);
  });

  it('creates on first send with the pending provider and moves the draft to the new conversation', async () => {
    store.setPendingSelection(PARENT_A, { provider: 'grok', model: 'grok-4' });
    store.setDraft(PARENT_A, null, 'How far along is this?');

    const ok = await store.send(PARENT_A, null, 'How far along is this?', '/work');

    expect(ok).toBe(true);
    expect(ipc['sideChatCreate']).toHaveBeenCalledWith(expect.objectContaining({
      parent: PARENT_A, selection: { provider: 'grok', model: 'grok-4' },
    }));
    expect(ipc['sideChatSend']).toHaveBeenCalledWith({ chatId: 'new-side', text: 'How far along is this?' });
    expect(store.selectedChatId(PARENT_A)).toBe('new-side');
    expect(store.draftFor(PARENT_A, null)).toBe('');
  });

  it('keeps a refused question and offers the last saved context', async () => {
    ipc['sideChatSend'].mockResolvedValue({
      success: false,
      error: { message: 'Parent session is gone' },
      data: { ok: false, code: 'parent-unavailable', lastSnapshotAvailable: true },
    });

    expect(await store.send(PARENT_A, 's1', 'Still there?', '/work')).toBe(false);
    expect(store.errorFor(PARENT_A)).toMatchObject({
      code: 'parent-unavailable', lastSnapshotAvailable: true, text: 'Still there?', chatId: 's1',
    });
    expect(store.draftFor(PARENT_A, 's1')).toBe('Still there?');

    ipc['sideChatSend'].mockResolvedValue({ success: true, data: { ok: true, usedStaleContext: true } });
    await store.send(PARENT_A, 's1', 'Still there?', '/work', { allowStaleContext: true });
    expect(ipc['sideChatSend']).toHaveBeenLastCalledWith({ chatId: 's1', text: 'Still there?', allowStaleContext: true });
    expect(store.errorFor(PARENT_A)).toBeNull();
  });

  it('acknowledges reads through a specific sequence and never rewinds locally', async () => {
    ipc['sideChatList'].mockResolvedValue({
      success: true, data: { active: [summary('s1', PARENT_A, 'unread', 0, 6)], archived: [] },
    });
    await store.refresh(PARENT_A);

    await store.markRead(PARENT_A, 's1', 6);
    await store.markRead(PARENT_A, 's1', 3);

    expect(ipc['sideChatMarkRead']).toHaveBeenCalledTimes(1);
    expect(ipc['sideChatMarkRead']).toHaveBeenCalledWith({ chatId: 's1', throughSequence: 6 });
    expect(store.summariesFor(PARENT_A)[0]).toMatchObject({ state: 'idle', link: { lastReadAssistantSequence: 6 } });
  });

  it('refreshes a loaded parent list when its attention changes', async () => {
    await store.initialize();
    await store.refresh(PARENT_A);
    ipc['sideChatList'].mockClear();

    emit({ type: 'side-chat-attention', attention: attention(PARENT_A, { running: 1 }) });
    emit({ type: 'side-chat-attention', attention: attention(PARENT_B, { running: 1 }) });

    expect(ipc['sideChatList']).toHaveBeenCalledTimes(1);
    expect(ipc['sideChatList']).toHaveBeenCalledWith({ parent: PARENT_A });
  });

  it('attaches an existing chat only on request and selects it', async () => {
    expect(await store.attach(PARENT_A, 'loose')).toBe(true);

    expect(ipc['sideChatAttach']).toHaveBeenCalledWith({ chatId: 'loose', parent: PARENT_A });
    expect(store.selectedChatId(PARENT_A)).toBe('loose');
  });

  it('raises distinct open requests for badges', () => {
    store.requestOpen(PARENT_A, 's1');
    const first = store.openRequest();
    store.requestOpen(PARENT_A, 's1');

    expect(store.openRequest()).toMatchObject({ parent: PARENT_A, chatId: 's1' });
    expect(store.openRequest()?.id).not.toBe(first?.id);
  });
});
