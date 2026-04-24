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
