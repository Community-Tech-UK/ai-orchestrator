import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

const mocks = vi.hoisted(() => ({
  lsp: {
    getAvailableServers: vi.fn(), getStatus: vi.fn(), goToDefinition: vi.fn(),
    findReferences: vi.fn(), hover: vi.fn(), getDocumentSymbols: vi.fn(),
    workspaceSymbols: vi.fn(), getDiagnostics: vi.fn(), isAvailableForFile: vi.fn(), stop: vi.fn(),
  },
  wake: {
    generateWakeContext: vi.fn(), getWakeUpText: vi.fn(), addHint: vi.fn(),
    removeHint: vi.fn(), setIdentity: vi.fn(), listHints: vi.fn(),
  },
  parallel: {
    startParallelExecution: vi.fn(), getExecution: vi.fn(), cancelExecution: vi.fn(),
    getTaskSession: vi.fn(), getActiveExecutions: vi.fn(), resolveConflict: vi.fn(), forceMerge: vi.fn(),
  },
  consensus: { query: vi.fn(), abortQuery: vi.fn(), getActiveQueryCount: vi.fn() },
  conversation: { importFile: vi.fn(), importFromString: vi.fn(), detectFormat: vi.fn() },
  observer: { getStatus: vi.fn(), start: vi.fn(), stop: vi.fn(), rotateToken: vi.fn() },
  snapshots: {
    takeSnapshot: vi.fn(), startSession: vi.fn(), endSession: vi.fn(),
    getSnapshotsForInstance: vi.fn(), getSnapshotsForFile: vi.fn(), getSessionsForInstance: vi.fn(),
    getSnapshotContent: vi.fn(), revertFile: vi.fn(), revertSession: vi.fn(), getSnapshotDiff: vi.fn(),
    deleteSnapshot: vi.fn(), cleanupOldSnapshots: vi.fn(), getStats: vi.fn(),
  },
  tasks: {
    getTask: vi.fn(), serializeTask: vi.fn(), getTaskHistory: vi.fn(),
    getTasksByParentId: vi.fn(), getTaskByChildId: vi.fn(), cancelTask: vi.fn(), getStats: vi.fn(),
  },
  getPreflight: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}));

vi.mock('../../../codemem', () => ({ getCodemem: () => ({ gateway: mocks.lsp }) }));
vi.mock('../../../memory/wake-context-builder', () => ({ getWakeContextBuilder: () => mocks.wake }));
vi.mock('../../../orchestration/parallel-worktree-coordinator', () => ({
  getParallelWorktreeCoordinator: () => mocks.parallel,
}));
vi.mock('../../../orchestration/consensus-coordinator', () => ({
  getConsensusCoordinator: () => mocks.consensus,
}));
vi.mock('../../../memory/conversation-miner', () => ({
  getConversationMiner: () => mocks.conversation,
  ConversationMiner: class { static detectFormat = mocks.conversation.detectFormat; },
}));
vi.mock('../../../remote/observer-server', () => ({ getRemoteObserverServer: () => mocks.observer }));
vi.mock('../../../persistence/snapshot-manager', () => ({ getSnapshotManager: () => mocks.snapshots }));
vi.mock('../../../orchestration/task-manager', () => ({ getTaskManager: () => mocks.tasks }));
vi.mock('../../../security/task-preflight-service', () => ({
  getTaskPreflightService: () => ({ getPreflight: mocks.getPreflight }),
}));
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { registerConsensusHandlers } from '../consensus-handlers';
import { registerConversationMiningHandlers } from '../conversation-mining-handlers';
import { registerLspHandlers } from '../lsp-handlers';
import { registerParallelWorktreeHandlers } from '../parallel-worktree-handlers';
import { registerRemoteObserverHandlers } from '../remote-observer-handlers';
import { registerSnapshotHandlers } from '../snapshot-handlers';
import { registerTaskHandlers } from '../task-handlers';
import { registerWakeContextHandlers } from '../wake-context-handlers';

async function invoke<T = unknown>(channel: string, payload?: unknown): Promise<IpcResponse<T>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, payload) as Promise<IpcResponse<T>>;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('LSP handlers', () => {
  it('routes a validated hover request', async () => {
    mocks.lsp.hover.mockResolvedValue({ contents: 'symbol docs' });
    registerLspHandlers();
    await expect(invoke(IPC_CHANNELS.LSP_HOVER, {
      filePath: '/repo/src/a.ts', line: 4, character: 2,
    })).resolves.toMatchObject({ success: true, data: { contents: 'symbol docs' } });
    expect(mocks.lsp.hover).toHaveBeenCalledWith('/repo/src/a.ts', 4, 2);
  });

  it('rejects an invalid position before reaching the LSP gateway', async () => {
    registerLspHandlers();
    await expect(invoke(IPC_CHANNELS.LSP_HOVER, {
      filePath: '/repo/src/a.ts', line: -1, character: 0,
    })).resolves.toMatchObject({ success: false, error: { code: 'LSP_HOVER_FAILED' } });
    expect(mocks.lsp.hover).not.toHaveBeenCalled();
  });
});

describe('wake-context handlers', () => {
  it('routes a validated hint', async () => {
    mocks.wake.addHint.mockReturnValue('hint-1');
    registerWakeContextHandlers();
    await expect(invoke(IPC_CHANNELS.WAKE_ADD_HINT, {
      content: 'Remember the migration', importance: 8, room: 'project',
    })).resolves.toEqual({ success: true, data: 'hint-1' });
    expect(mocks.wake.addHint).toHaveBeenCalledWith('Remember the migration', expect.objectContaining({ importance: 8 }));
  });

  it('rejects an empty hint', async () => {
    registerWakeContextHandlers();
    await expect(invoke(IPC_CHANNELS.WAKE_ADD_HINT, { content: '' }))
      .resolves.toMatchObject({ success: false, error: { code: 'WAKE_ADD_HINT_FAILED' } });
    expect(mocks.wake.addHint).not.toHaveBeenCalled();
  });
});

describe('parallel-worktree handlers', () => {
  it('routes a validated cancellation', async () => {
    mocks.parallel.cancelExecution.mockResolvedValue(undefined);
    registerParallelWorktreeHandlers();
    await expect(invoke(IPC_CHANNELS.PARALLEL_WORKTREE_CANCEL, { executionId: 'exec-1' }))
      .resolves.toEqual({ success: true, data: { executionId: 'exec-1' } });
    expect(mocks.parallel.cancelExecution).toHaveBeenCalledWith('exec-1');
  });

  it('rejects an empty execution id', async () => {
    registerParallelWorktreeHandlers();
    await expect(invoke(IPC_CHANNELS.PARALLEL_WORKTREE_CANCEL, { executionId: '' }))
      .resolves.toMatchObject({ success: false, error: { code: 'PARALLEL_WORKTREE_CANCEL_FAILED' } });
    expect(mocks.parallel.cancelExecution).not.toHaveBeenCalled();
  });
});

describe('consensus handlers', () => {
  it('routes a validated abort request', async () => {
    mocks.consensus.abortQuery.mockReturnValue(true);
    registerConsensusHandlers();
    await expect(invoke(IPC_CHANNELS.CONSENSUS_ABORT, { queryId: 'query-1' }))
      .resolves.toEqual({ success: true, data: { queryId: 'query-1', aborted: true } });
    expect(mocks.consensus.abortQuery).toHaveBeenCalledWith('query-1');
  });

  it('rejects an empty query id', async () => {
    registerConsensusHandlers();
    await expect(invoke(IPC_CHANNELS.CONSENSUS_ABORT, { queryId: '' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONSENSUS_ABORT_FAILED' } });
    expect(mocks.consensus.abortQuery).not.toHaveBeenCalled();
  });
});

describe('conversation-mining handlers', () => {
  it('routes validated content to format detection', async () => {
    mocks.conversation.detectFormat.mockReturnValue('claude');
    registerConversationMiningHandlers();
    await expect(invoke(IPC_CHANNELS.CONVO_DETECT_FORMAT, { content: '{"type":"user"}' }))
      .resolves.toEqual({ success: true, data: 'claude' });
    expect(mocks.conversation.detectFormat).toHaveBeenCalledWith('{"type":"user"}');
  });

  it('rejects empty conversation content', async () => {
    registerConversationMiningHandlers();
    await expect(invoke(IPC_CHANNELS.CONVO_DETECT_FORMAT, { content: '' }))
      .resolves.toMatchObject({ success: false, error: { code: 'CONVO_DETECT_FORMAT_FAILED' } });
    expect(mocks.conversation.detectFormat).not.toHaveBeenCalled();
  });
});

describe('remote-observer handlers', () => {
  it('routes validated host and port options', async () => {
    mocks.observer.start.mockResolvedValue({ running: true, port: 8787 });
    registerRemoteObserverHandlers();
    await expect(invoke(IPC_CHANNELS.REMOTE_OBSERVER_START, { host: '127.0.0.1', port: 8787 }))
      .resolves.toMatchObject({ success: true, data: { running: true, port: 8787 } });
    expect(mocks.observer.start).toHaveBeenCalledWith('127.0.0.1', 8787);
  });

  it('rejects an out-of-range port', async () => {
    registerRemoteObserverHandlers();
    await expect(invoke(IPC_CHANNELS.REMOTE_OBSERVER_START, { port: 70_000 }))
      .resolves.toMatchObject({ success: false, error: { code: 'REMOTE_OBSERVER_START_FAILED' } });
    expect(mocks.observer.start).not.toHaveBeenCalled();
  });
});

describe('snapshot handlers', () => {
  it('routes a validated snapshot request', async () => {
    mocks.snapshots.takeSnapshot.mockReturnValue('snapshot-1');
    registerSnapshotHandlers();
    await expect(invoke(IPC_CHANNELS.SNAPSHOT_TAKE, {
      filePath: '/repo/src/a.ts', instanceId: 'inst-1', action: 'modify',
    })).resolves.toEqual({ success: true, data: { snapshotId: 'snapshot-1' } });
    expect(mocks.snapshots.takeSnapshot).toHaveBeenCalledWith('/repo/src/a.ts', 'inst-1', undefined, 'modify');
  });

  it('rejects a missing file path', async () => {
    registerSnapshotHandlers();
    await expect(invoke(IPC_CHANNELS.SNAPSHOT_TAKE, { instanceId: 'inst-1' }))
      .resolves.toMatchObject({ success: false, error: { code: 'SNAPSHOT_TAKE_FAILED' } });
    expect(mocks.snapshots.takeSnapshot).not.toHaveBeenCalled();
  });
});

describe('task handlers', () => {
  it('routes and serializes a validated task lookup', async () => {
    const task = { id: 'task-1' };
    mocks.tasks.getTask.mockReturnValue(task);
    mocks.tasks.serializeTask.mockReturnValue({ id: 'task-1', status: 'running' });
    registerTaskHandlers();
    await expect(invoke(IPC_CHANNELS.TASK_GET_STATUS, { taskId: 'task-1' }))
      .resolves.toMatchObject({ success: true, data: { id: 'task-1', status: 'running' } });
    expect(mocks.tasks.serializeTask).toHaveBeenCalledWith(task);
  });

  it('rejects an empty task id', async () => {
    registerTaskHandlers();
    await expect(invoke(IPC_CHANNELS.TASK_GET_STATUS, { taskId: '' }))
      .resolves.toMatchObject({ success: false, error: { code: 'TASK_GET_STATUS_FAILED' } });
    expect(mocks.tasks.getTask).not.toHaveBeenCalled();
  });
});
