import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type {
  OperatorRunGraph,
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
    expect(store.messageCount()).toBe(0);

    store.select();
    await store.sendMessage('Pull all repos');

    expect(store.selected()).toBe(true);
    expect(store.thread()?.provider).toBe('orchestrator');
    expect(store.messageCount()).toBe(1);
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
    expect(store.activeRunGraph()?.run.title).toBe('Pull repositories');
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

  it('rescans operator projects during initialization when the registry is empty', async () => {
    const ipc = new FakeOperatorIpcService({ projects: [] });
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();

    expect(ipc.rescanRequests).toEqual([{}]);
    expect(store.projects().map((project) => project.displayName)).toEqual(['Dingley']);
  });

  it('subscribes to operator events and reloads runs when progress changes', async () => {
    const ipc = new FakeOperatorIpcService();
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();
    ipc.runs = [makeRun({ status: 'completed', updatedAt: 4 })];
    await ipc.emitOperatorEvent({
      runId: 'run-1',
      event: {
        id: 'event-1',
        runId: 'run-1',
        nodeId: null,
        kind: 'state-change',
        payload: { status: 'completed' },
        createdAt: 4,
      },
    });

    expect(ipc.operatorEventSubscribers).toBe(1);
    expect(ipc.listRunsCalls).toBeGreaterThanOrEqual(2);
    expect(store.runs()).toEqual([
      expect.objectContaining({
        status: 'completed',
        updatedAt: 4,
      }),
    ]);
  });

  it('reloads operator transcript messages when run events arrive', async () => {
    const ipc = new FakeOperatorIpcService();
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();
    ipc.appendAssistantMessage('Completed: Audit Dingley');
    await ipc.emitOperatorEvent({
      runId: 'run-1',
      event: {
        id: 'event-1',
        runId: 'run-1',
        nodeId: null,
        kind: 'state-change',
        payload: { status: 'completed' },
        createdAt: 4,
      },
    });

    expect(store.messages().map((message) => message.content)).toContain('Completed: Audit Dingley');
  });

  it('can cancel and retry operator runs through IPC', async () => {
    const ipc = new FakeOperatorIpcService();
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore) as OperatorStore & {
      cancelRun(runId: string): Promise<void>;
      retryRun(runId: string): Promise<void>;
    };
    ipc.runs = [makeRun({ id: 'run-1', status: 'running' })];

    await store.initialize();
    await store.cancelRun('run-1');
    await store.retryRun('run-1');

    expect(ipc.cancelledRuns).toEqual(['run-1']);
    expect(ipc.retriedRuns).toEqual(['run-1']);
    expect(store.runs()).toEqual([
      expect.objectContaining({
        id: 'run-2',
        status: 'running',
      }),
    ]);
  });

  it('derives target chips from the active run graph instead of the whole project list', async () => {
    const ipc = new FakeOperatorIpcService({
      projects: [
        makeProject('project-1', 'AI Orchestrator', '/work/ai-orchestrator'),
        makeProject('project-2', 'Unrelated', '/work/unrelated'),
      ],
    });
    ipc.runs = [
      makeRun({
        id: 'run-1',
        title: 'Implement in AI Orchestrator',
        planJson: {
          intent: 'project_feature',
          projectId: 'project-1',
          projectPath: '/work/ai-orchestrator',
        },
      }),
    ];
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();

    expect(store.targetChips()).toEqual([
      { label: 'AI Orchestrator', path: '/work/ai-orchestrator' },
    ]);
  });

  it('derives pinned Orchestrator row status and active run count from current runs', async () => {
    const ipc = new FakeOperatorIpcService();
    ipc.runs = [
      makeRun({ id: 'run-1', status: 'running' }),
      makeRun({ id: 'run-2', status: 'blocked' }),
      makeRun({ id: 'run-3', status: 'completed' }),
    ];
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();

    expect(store.activeRunCount()).toBe(1);
    expect(store.statusTone()).toBe('running');
    expect(store.statusLabel()).toBe('Running');
  });

  it('surfaces a blocked latest run as attention instead of an active run', async () => {
    const ipc = new FakeOperatorIpcService();
    ipc.runs = [
      makeRun({ id: 'run-1', status: 'blocked' }),
      makeRun({ id: 'run-2', status: 'completed' }),
    ];
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();

    expect(store.activeRunCount()).toBe(0);
    expect(store.statusTone()).toBe('attention');
    expect(store.statusLabel()).toBe('Attention');
  });

  it('surfaces a waiting latest run as attention while keeping it in the active count', async () => {
    const ipc = new FakeOperatorIpcService();
    ipc.runs = [
      makeRun({ id: 'run-1', status: 'waiting' }),
      makeRun({ id: 'run-2', status: 'completed' }),
    ];
    TestBed.configureTestingModule({
      providers: [
        OperatorStore,
        { provide: OperatorIpcService, useValue: ipc },
      ],
    });
    const store = TestBed.inject(OperatorStore);

    await store.initialize();

    expect(store.activeRunCount()).toBe(1);
    expect(store.statusTone()).toBe('attention');
    expect(store.statusLabel()).toBe('Attention');
  });
});

class FakeOperatorIpcService {
  sentMessages: string[] = [];
  rescanRequests: OperatorProjectRefreshOptions[] = [];
  cancelledRuns: string[] = [];
  retriedRuns: string[] = [];
  listRunsCalls = 0;
  operatorEventSubscribers = 0;
  runs: OperatorRunRecord[] = [];
  private operatorEventCallback: ((payload: unknown) => void | Promise<void>) | null = null;
  private projects: OperatorProjectRecord[];
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

  constructor(options: { projects?: OperatorProjectRecord[] } = {}) {
    this.projects = options.projects ?? [
      makeProject('project-1', 'AI Orchestrator', '/work/ai-orchestrator'),
    ];
  }

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
    this.listRunsCalls += 1;
    return {
      success: true,
      data: this.runs,
    };
  }

  async getRun(runId: string) {
    const run = this.runs.find((candidate) => candidate.id === runId) ?? makeRun({ id: runId });
    return {
      success: true,
      data: makeRunGraph(run),
    };
  }

  async rescanProjects(payload: OperatorProjectRefreshOptions) {
    this.rescanRequests.push(payload);
    if (!this.projects.some((project) => project.id === 'project-2')) {
      this.projects = [
        ...this.projects,
        makeProject('project-2', 'Dingley', '/work/dingley'),
      ];
    }
    return {
      success: true,
      data: this.projects,
    };
  }

  async cancelRun(runId: string) {
    this.cancelledRuns.push(runId);
    this.runs = this.runs.map((run) =>
      run.id === runId ? makeRun({ ...run, status: 'cancelled', completedAt: 3 }) : run
    );
    return {
      success: true,
      data: {
        run: this.runs.find((run) => run.id === runId) ?? null,
        nodes: [],
        events: [],
      },
    };
  }

  async retryRun(runId: string) {
    this.retriedRuns.push(runId);
    this.runs = [makeRun({ id: 'run-2', sourceMessageId: `${runId}:retry`, status: 'running' })];
    return {
      success: true,
      data: {
        run: this.runs[0],
        nodes: [],
        events: [],
      },
    };
  }

  onOperatorEvent(callback: (payload: unknown) => void | Promise<void>): () => void {
    this.operatorEventSubscribers += 1;
    this.operatorEventCallback = callback;
    return () => {
      this.operatorEventCallback = null;
    };
  }

  async emitOperatorEvent(payload: unknown): Promise<void> {
    await this.operatorEventCallback?.(payload);
  }

  appendAssistantMessage(content: string): void {
    const sequence = this.conversation.messages.length + 1;
    this.conversation = {
      ...this.conversation,
      messages: [
        ...this.conversation.messages,
        {
          id: `message-${sequence}`,
          threadId: 'thread-1',
          nativeMessageId: `message-${sequence}:assistant`,
          nativeTurnId: `turn-${sequence}`,
          role: 'assistant',
          phase: null,
          content,
          createdAt: sequence,
          tokenInput: null,
          tokenOutput: null,
          rawRef: null,
          rawJson: null,
          sourceChecksum: null,
          sequence,
        },
      ],
    };
  }
}

function makeRun(overrides: Partial<OperatorRunRecord> = {}): OperatorRunRecord {
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
    ...overrides,
  };
}

function makeRunGraph(run: OperatorRunRecord): OperatorRunGraph {
  return {
    run,
    nodes: [
      {
        id: 'node-1',
        runId: run.id,
        parentNodeId: null,
        type: 'project-agent',
        status: run.status,
        targetProjectId: typeof run.planJson['projectId'] === 'string' ? run.planJson['projectId'] : null,
        targetPath: typeof run.planJson['projectPath'] === 'string' ? run.planJson['projectPath'] : null,
        title: run.title,
        inputJson: {},
        outputJson: null,
        externalRefKind: null,
        externalRefId: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: null,
        error: null,
      },
    ],
    events: [],
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
