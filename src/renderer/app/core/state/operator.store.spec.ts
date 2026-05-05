import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type { OperatorThreadResult } from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../services/ipc/operator-ipc.service';
import { OperatorStore } from './operator.store';

function makeConversation(messages: ConversationLedgerConversation['messages'] = []): ConversationLedgerConversation {
  return {
    thread: {
      id: 'thread-operator',
      provider: 'orchestrator',
      nativeThreadId: 'orchestrator:global',
      nativeSessionId: null,
      nativeSourceKind: 'internal',
      sourceKind: 'orchestrator',
      sourcePath: null,
      workspacePath: null,
      title: 'Orchestrator',
      createdAt: 1,
      updatedAt: 2,
      lastSyncedAt: null,
      writable: true,
      nativeVisibilityMode: 'none',
      syncStatus: 'synced',
      conflictStatus: 'none',
      parentConversationId: null,
      metadata: {},
    },
    messages,
  };
}

describe('OperatorStore', () => {
  let store: OperatorStore;
  let ipc: {
    getThread: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    listRuns: ReturnType<typeof vi.fn>;
    listProjects: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const initial: OperatorThreadResult = {
      conversation: makeConversation(),
      runs: [],
      projects: [],
    };
    const afterSend: OperatorThreadResult = {
      conversation: makeConversation([
        {
          id: 'msg-1',
          threadId: 'thread-operator',
          nativeMessageId: 'msg-user',
          nativeTurnId: 'turn-1',
          role: 'user',
          phase: 'input',
          content: 'Coordinate active work',
          createdAt: 3,
          tokenInput: null,
          tokenOutput: null,
          rawRef: null,
          rawJson: null,
          sourceChecksum: null,
          sequence: 1,
        },
      ]),
      runs: [],
      projects: [],
    };
    ipc = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: initial }),
      sendMessage: vi.fn().mockResolvedValue({ success: true, data: { ...afterSend, run: null } }),
      listRuns: vi.fn(),
      listProjects: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    store = TestBed.inject(OperatorStore);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads the global operator thread once and exposes message counts', async () => {
    await store.initialize();
    await store.initialize();

    expect(ipc.getThread).toHaveBeenCalledTimes(1);
    expect(store.thread()?.provider).toBe('orchestrator');
    expect(store.messageCount()).toBe(0);
  });

  it('sends messages through IPC and replaces the transcript from the response', async () => {
    await store.initialize();
    const sent = await store.sendMessage('  Coordinate active work  ');

    expect(sent).toBe(true);
    expect(ipc.sendMessage).toHaveBeenCalledWith({ text: 'Coordinate active work' });
    expect(store.messages().map(message => message.content)).toEqual(['Coordinate active work']);
  });
});
