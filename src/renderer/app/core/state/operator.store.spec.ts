import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
  OperatorRunRecord,
} from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../services/ipc/operator-ipc.service';
import { OperatorStore } from './operator.store';

describe('OperatorStore', () => {
  it('loads, selects, and sends messages through the global thread', async () => {
    const ipc = new FakeOperatorIpcService();
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();
    store.select();
    await store.sendMessage('Pull all repos');

    expect(store.selected()).toBe(true);
    expect(store.thread()?.provider).toBe('orchestrator');
    expect(store.messages()).toHaveLength(1);
    expect(store.messages()[0]).toMatchObject({
      role: 'user',
      content: 'Pull all repos',
    });
    expect(ipc.sentMessages).toEqual(['Pull all repos']);
    expect(store.runs()).toEqual([
      expect.objectContaining({
        title: 'Pull repositories',
        status: 'running',
      }),
    ]);
  });

  it('loads and rescans operator projects', async () => {
    const ipc = new FakeOperatorIpcService();
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();
    await store.rescanProjects({ roots: ['/work'] });

    expect(store.projects().map((project) => project.displayName)).toEqual([
      'AI Orchestrator',
      'Dingley',
    ]);
    expect(ipc.rescanRequests).toEqual([{ roots: ['/work'] }]);
  });
});

class FakeOperatorIpcService {
  sentMessages: string[] = [];
  rescanRequests: OperatorProjectRefreshOptions[] = [];
  private runs: OperatorRunRecord[] = [];
  private projects: OperatorProjectRecord[] = [
    makeProject('project-1', 'AI Orchestrator', '/work/ai-orchestrator'),
  ];
  private conversation: ConversationLedgerConversation = {
    thread: {
      id: 'thread-1',
      provider: 'orchestrator',
      nativeThreadId: 'orchestrator-global',
      nativeSessionId: 'orchestrator-global',
      nativeSourceKind: 'internal',
      sourceKind: 'orchestrator',
      sourcePath: null,
      workspacePath: null,
      title: 'Orchestrator',
      createdAt: 1,
      updatedAt: 1,
      lastSyncedAt: null,
      writable: true,
      nativeVisibilityMode: 'none',
      syncStatus: 'synced',
      conflictStatus: 'none',
      parentConversationId: null,
      metadata: { scope: 'global', operatorThreadKind: 'root' },
    },
    messages: [],
  };

  async getThread() {
    return {
      success: true,
      data: this.conversation,
    };
  }

  async sendMessage(payload: { text: string }) {
    this.sentMessages.push(payload.text);
    this.runs = [makeRun()];
    this.conversation = {
      ...this.conversation,
      messages: [
        {
          id: 'message-1',
          threadId: 'thread-1',
          nativeMessageId: 'turn-1:user',
          nativeTurnId: 'turn-1',
          role: 'user',
          phase: null,
          content: payload.text,
          createdAt: 2,
          tokenInput: null,
          tokenOutput: null,
          rawRef: null,
          rawJson: null,
          sourceChecksum: null,
          sequence: 1,
        },
      ],
    };
    return {
      success: true,
      data: this.conversation,
    };
  }

  async listProjects() {
    return {
      success: true,
      data: this.projects,
    };
  }

  async listRuns() {
    return {
      success: true,
      data: this.runs,
    };
  }

  async rescanProjects(payload: OperatorProjectRefreshOptions) {
    this.rescanRequests.push(payload);
    this.projects = [
      ...this.projects,
      makeProject('project-2', 'Dingley', '/work/dingley'),
    ];
    return {
      success: true,
      data: this.projects,
    };
  }
}

function makeRun(): OperatorRunRecord {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    title: 'Pull repositories',
    status: 'running',
    autonomyMode: 'full',
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    goal: 'Pull all repos',
    budget: {
      maxNodes: 50,
      maxRetries: 3,
      maxWallClockMs: 7200000,
      maxConcurrentNodes: 3,
    },
    usageJson: {
      nodesStarted: 1,
      nodesCompleted: 0,
      retriesUsed: 0,
      wallClockMs: 0,
    },
    planJson: {},
    resultJson: null,
    error: null,
  };
}

function makeProject(id: string, displayName: string, canonicalPath: string): OperatorProjectRecord {
  return {
    id,
    canonicalPath,
    displayName,
    aliases: [displayName],
    source: 'manual',
    gitRoot: canonicalPath,
    remotes: [],
    currentBranch: null,
    isPinned: false,
    lastSeenAt: 1,
    lastAccessedAt: null,
    metadata: {},
  };
}
