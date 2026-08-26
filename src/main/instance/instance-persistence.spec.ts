import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ForkConfig,
  Instance,
  InstanceCreateConfig,
  OutputMessage,
} from '../../shared/types/instance.types';
import { createDefaultContextInheritance } from '../../shared/types/supervision.types';

const loadMessagesMock = vi.fn();
const getInstanceStatsMock = vi.fn();
const deleteInstanceMock = vi.fn();

vi.mock('../memory', () => ({
  getOutputStorageManager: () => ({
    loadMessages: loadMessagesMock,
    getInstanceStats: getInstanceStatsMock,
    deleteInstance: deleteInstanceMock,
  }),
}));

import { InstancePersistenceManager } from './instance-persistence';

function message(id: string, content = id): OutputMessage {
  return {
    id,
    timestamp: Date.now(),
    type: 'assistant',
    content,
  };
}

function createInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Test Instance',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: createDefaultContextInheritance(),
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'idle',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: Date.now(),
    currentActivity: undefined,
    currentTool: undefined,
    processId: null,
    sessionId: 'session-1',
    providerSessionId: 'session-1',
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    currentModel: undefined,
    diffStats: undefined,
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    readyPromise: undefined,
    abortController: undefined,
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    restartEpoch: 0,
    ...overrides,
  };
}

describe('InstancePersistenceManager', () => {
  let sourceInstance: Instance;
  let createInstanceMock: ReturnType<typeof vi.fn>;
  let manager: InstancePersistenceManager;

  beforeEach(() => {
    loadMessagesMock.mockReset();
    getInstanceStatsMock.mockReset();
    deleteInstanceMock.mockReset();

    sourceInstance = createInstance({
      outputBuffer: [message('live-1'), message('live-2'), message('live-3')],
    });

    createInstanceMock = vi.fn(async (config: InstanceCreateConfig) =>
      createInstance({
        id: 'forked-instance',
        displayName: config.displayName ?? 'Forked Instance',
        outputBuffer: config.initialOutputBuffer ?? [],
      }),
    );

    manager = new InstancePersistenceManager({
      getInstance: (id) => (id === sourceInstance.id ? sourceInstance : undefined),
      createInstance: createInstanceMock,
    });
  });

  it('forks against the combined stored and live transcript', async () => {
    loadMessagesMock.mockResolvedValue([message('older-1'), message('older-2')]);

    const config: ForkConfig = {
      instanceId: sourceInstance.id,
      atMessageIndex: 4,
      displayName: 'Fork at message 4',
    };

    const forked = await manager.forkInstance(config);

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOutputBuffer: [
          expect.objectContaining({ id: 'older-1' }),
          expect.objectContaining({ id: 'older-2' }),
          expect.objectContaining({ id: 'live-1' }),
          expect.objectContaining({ id: 'live-2' }),
        ],
      }),
    );
    expect(forked.outputBuffer.map((entry) => entry.id)).toEqual([
      'older-1',
      'older-2',
      'live-1',
      'live-2',
    ]);
  });

  it('deduplicates overlap between disk history and the live buffer', async () => {
    loadMessagesMock.mockResolvedValue([message('older-1'), message('live-1')]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      atMessageIndex: 3,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOutputBuffer: [
          expect.objectContaining({ id: 'older-1' }),
          expect.objectContaining({ id: 'live-1' }),
          expect.objectContaining({ id: 'live-2' }),
        ],
      }),
    );
  });

  it('forks by stable source message id and preserves runtime settings plus attachments', async () => {
    const attachment = {
      name: 'diagram.png',
      type: 'image/png',
      size: 12,
      data: 'data:image/png;base64,abc',
    };
    sourceInstance.provider = 'codex';
    sourceInstance.currentModel = 'gpt-5.3-codex';
    sourceInstance.yoloMode = true;
    sourceInstance.outputBuffer = [
      message('assistant-1'),
      { ...message('user-2'), type: 'user', attachments: [attachment] },
      message('assistant-3'),
    ];
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'user-2',
      initialPrompt: ' revised with leading space',
      preserveRuntimeSettings: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        modelOverride: 'gpt-5.3-codex',
        yoloMode: true,
        initialPrompt: ' revised with leading space',
        attachments: [attachment],
        initialOutputBuffer: [
          expect.objectContaining({ id: 'assistant-1' }),
        ],
      }),
    );
  });

  it('preserves a provider-decided runtime instead of escalating the fork to the default', async () => {
    // An instance with no stored effort is one running provider-decided. Passing
    // `undefined` would read as "unchosen" at spawn and re-apply the app default
    // ('high' for codex), silently escalating a fork of a deliberately cheap run.
    sourceInstance.provider = 'codex';
    sourceInstance.reasoningEffort = undefined;
    sourceInstance.outputBuffer = [message('assistant-1')];
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'assistant-1',
      preserveRuntimeSettings: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: null }),
    );
  });

  it('carries an explicit effort through a preserved fork', async () => {
    sourceInstance.provider = 'codex';
    sourceInstance.reasoningEffort = 'low';
    sourceInstance.outputBuffer = [message('assistant-1')];
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'assistant-1',
      preserveRuntimeSettings: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'low' }),
    );
  });

  it('adds hidden replay context for prompted forks without changing the visible prompt', async () => {
    sourceInstance.outputBuffer = [
      { ...message('user-1', 'original setup context'), type: 'user' },
      message('assistant-2', 'previous answer context'),
      { ...message('user-3', 'message being edited'), type: 'user' },
      message('assistant-4', 'superseded response'),
    ];
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'user-3',
      initialPrompt: 'edited follow-up',
      supersedeSource: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOutputBuffer: [
          expect.objectContaining({ id: 'user-1' }),
          expect.objectContaining({ id: 'assistant-2' }),
        ],
        initialPrompt: 'edited follow-up',
        initialContextBlock: expect.stringContaining('original setup context'),
      }),
    );
    const createConfig = createInstanceMock.mock.calls[0]?.[0] as { initialContextBlock?: string };
    expect(createConfig.initialContextBlock).toContain('previous answer context');
    expect(createConfig.initialContextBlock).not.toContain('edited follow-up');
  });

  it('copies source metadata when preserving runtime settings across a fork', async () => {
    sourceInstance.metadata = {
      operatorRunId: 'run-1',
      operatorNodeId: 'node-1',
      custom: true,
    };
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      atMessageIndex: 1,
      preserveRuntimeSettings: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          operatorRunId: 'run-1',
          operatorNodeId: 'node-1',
          custom: true,
        },
      }),
    );
  });

  it('inherits the source historyThreadId on supersede-edit forks so the rail collapses to one entry', async () => {
    // Edit-and-resend forks (supersedeSource: true) are logically the same
    // conversation thread as the source. Sharing the threadId lets:
    //   - the live-rail filter hide the source's history entry once the fork
    //     is live (no duplicate row);
    //   - history-manager dedupe on threadId so the fork's eventual archive
    //     replaces the source's archived entry on disk.
    sourceInstance.historyThreadId = 'source-thread-1';
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      atMessageIndex: 0,
      sourceMessageId: 'user-1',
      initialPrompt: 'edited question',
      supersedeSource: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        historyThreadId: 'source-thread-1',
      }),
    );
  });

  it('does not pass a historyThreadId on divergent forks so both branches stay independently visible', async () => {
    // A regular fork (no supersedeSource) is an explicit branch — the user
    // wants both threads preserved, so the fork must get a fresh threadId.
    sourceInstance.historyThreadId = 'source-thread-2';
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      atMessageIndex: 1,
      preserveRuntimeSettings: true,
    });

    const call = createInstanceMock.mock.calls[0]?.[0] as { historyThreadId?: string } | undefined;
    expect(call?.historyThreadId).toBeUndefined();
  });

  it('uses forkAfterMessageId for the transcript cut while preserving source message attachments', async () => {
    const attachment = {
      name: 'sketch.png',
      type: 'image/png',
      size: 9,
      data: 'data:image/png;base64,xyz',
    };
    sourceInstance.outputBuffer = [
      { ...message('user-1'), type: 'user' },
      message('assistant-2'),
      { ...message('user-3'), type: 'user', attachments: [attachment] },
      message('assistant-4'),
    ];
    loadMessagesMock.mockResolvedValue([]);

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'user-3',
      forkAfterMessageId: 'assistant-2',
      initialPrompt: 'edited follow-up',
      preserveRuntimeSettings: true,
    });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOutputBuffer: [
          expect.objectContaining({ id: 'user-1' }),
          expect.objectContaining({ id: 'assistant-2' }),
        ],
        initialPrompt: 'edited follow-up',
        attachments: [attachment],
      }),
    );
  });
});

describe('InstancePersistenceManager fork prompt inheritance', () => {
  let sourceInstance: Instance;
  let createInstanceMock: ReturnType<typeof vi.fn>;
  let manager: InstancePersistenceManager;

  const prompt = (id: string, content: string, timestamp: number): OutputMessage =>
    ({ id, timestamp, type: 'user', content });
  const at = (id: string, timestamp: number): OutputMessage =>
    ({ id, timestamp, type: 'assistant', content: id });

  beforeEach(() => {
    loadMessagesMock.mockReset().mockResolvedValue([]);
    createInstanceMock = vi.fn(async (config: InstanceCreateConfig) =>
      createInstance({ id: 'forked-instance', outputBuffer: config.initialOutputBuffer ?? [] }),
    );
    // Compaction evicted the opening prompt and wrote nothing to disk, so the
    // retained set is the only remaining record of the original ask.
    sourceInstance = createInstance({
      outputBuffer: [at('live-1', 10), at('live-2', 11), at('live-3', 12)],
      retainedPrompts: [prompt('p0', 'Migrate the billing service.', 1)],
    });
    manager = new InstancePersistenceManager({
      getInstance: (id) => (id === sourceInstance.id ? sourceInstance : undefined),
      createInstance: createInstanceMock,
    });
  });

  it('passes the source retained prompts to the fork', async () => {
    await manager.forkInstance({ instanceId: sourceInstance.id, atMessageIndex: 3 });

    expect(createInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialRetainedPrompts: [expect.objectContaining({ id: 'p0' })],
      }),
    );
  });

  it('keeps them out of the forked buffer so fork indices stay addressable', async () => {
    await manager.forkInstance({ instanceId: sourceInstance.id, atMessageIndex: 3 });

    const config = createInstanceMock.mock.calls[0][0] as InstanceCreateConfig;
    expect(config.initialOutputBuffer?.map((m) => m.id)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('inherits the opening prompt when editing the oldest still-visible message', async () => {
    // The reachable regression: compaction shrank the buffer, the user edits
    // the oldest message they can still see, so forkIndex resolves to 0 and the
    // forked slice is empty — the original ask must still survive.
    sourceInstance.outputBuffer = [prompt('u5', 'oldest visible ask', 10), at('live-2', 11)];

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      sourceMessageId: 'u5',
      initialPrompt: 'Actually, do it the other way.',
      supersedeSource: true,
    });

    const config = createInstanceMock.mock.calls[0][0] as InstanceCreateConfig;
    expect(config.initialOutputBuffer).toEqual([]);
    expect(config.initialRetainedPrompts?.map((m) => m.id)).toEqual(['p0']);
  });

  it('drops a retained prompt the fork branched away before', async () => {
    // Reachable only when the prompt is also on disk, since retained prompts
    // are by construction older than anything still in the live buffer.
    const later = prompt('p5', 'A later ask.', 5);
    loadMessagesMock.mockResolvedValue([at('older-1', 1), later, at('older-3', 6)]);
    sourceInstance.retainedPrompts = [later];

    // forkIndex 1 keeps only 'older-1', so 'p5' is the excluded boundary.
    await manager.forkInstance({ instanceId: sourceInstance.id, atMessageIndex: 1 });

    const config = createInstanceMock.mock.calls[0][0] as InstanceCreateConfig;
    expect(config.initialOutputBuffer?.map((m) => m.id)).toEqual(['older-1']);
    expect(config.initialRetainedPrompts ?? []).toEqual([]);
  });

  it('anchors the original request in an edit-and-resend context block', async () => {
    // A later prompt in the forked window, so the opening ask is no longer the
    // current objective and must be anchored separately to survive.
    sourceInstance.outputBuffer = [
      at('live-1', 10),
      prompt('u9', 'carry on', 11),
      at('live-3', 12),
    ];

    await manager.forkInstance({
      instanceId: sourceInstance.id,
      atMessageIndex: 3,
      initialPrompt: 'Actually, do it the other way.',
      supersedeSource: true,
    });

    const config = createInstanceMock.mock.calls[0][0] as InstanceCreateConfig;
    expect(config.initialContextBlock).toContain('Original request:');
    expect(config.initialContextBlock).toContain('Migrate the billing service.');
  });
});

describe('InstancePersistenceManager export prompt retention', () => {
  const prompt = (id: string, content: string, timestamp: number): OutputMessage =>
    ({ id, timestamp, type: 'user', content });
  const at = (id: string, timestamp: number): OutputMessage =>
    ({ id, timestamp, type: 'assistant', content: id });

  function managerFor(instance: Instance) {
    return new InstancePersistenceManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      createInstance: vi.fn(),
    });
  }

  it('includes an opening prompt the live buffer no longer holds', () => {
    const instance = createInstance({
      outputBuffer: [at('live-1', 10)],
      retainedPrompts: [prompt('p0', 'Migrate the billing service.', 1)],
    });

    const exported = managerFor(instance).exportSession(instance.id);

    expect(exported.messages.map((m) => m.content)).toEqual([
      'Migrate the billing service.',
      'live-1',
    ]);
    expect(exported.metadata.totalMessages).toBe(2);
  });

  it('does not duplicate a prompt the buffer still holds, even under a renumbered id', () => {
    const opening = prompt('p0', 'Migrate the billing service.', 1);
    const instance = createInstance({
      outputBuffer: [opening, at('live-1', 10)],
      retainedPrompts: [prompt('restored-prompt-msg-0', 'Migrate the billing service.', 1)],
    });

    const exported = managerFor(instance).exportSession(instance.id);

    expect(exported.messages).toHaveLength(2);
  });

  it('carries the retained prompt into the Markdown export too', () => {
    const instance = createInstance({
      outputBuffer: [at('live-1', 10)],
      retainedPrompts: [prompt('p0', 'Migrate the billing service.', 1)],
    });

    expect(managerFor(instance).exportSessionMarkdown(instance.id))
      .toContain('Migrate the billing service.');
  });
});
