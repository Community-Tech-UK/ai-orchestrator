import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { InstanceManager } from '../../../instance/instance-manager';
import type { WorkflowManager } from '../../../workflows/workflow-manager';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

const getEntries = vi.fn();
vi.mock('../../../history/history-manager', () => ({
  getHistoryManager: () => ({
    getEntries,
  }),
}));

import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { registerHistorySearchHandlers } from '../history-search-handlers';
import { registerResumeHandlers } from '../resume-handlers';
import { registerWorkflowHandlers } from '../workflow-handlers';

async function invoke<T = Record<string, unknown>>(
  channel: string,
  payload?: unknown,
): Promise<IpcResponse<T>> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }

  return handler({}, payload) as Promise<IpcResponse<T>>;
}

describe('wave 3 IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('routes advanced history search and snippet expansion through their coordinators', async () => {
    const search = {
      search: vi.fn().mockResolvedValue({
        entries: [{ id: 'entry-1' }],
        recallResults: [],
        page: { pageNumber: 1, pageSize: 1, totalCount: 1, totalPages: 1 },
      }),
    };
    const snippets = {
      expandSnippetsOnDemand: vi.fn().mockResolvedValue([{ position: 2, excerpt: 'auth bug', score: 1 }]),
    };

    registerHistorySearchHandlers({ search, snippets });

    const searchResult = await invoke(IPC_CHANNELS.HISTORY_SEARCH_ADVANCED, {
      searchQuery: 'auth',
      source: 'history-transcript',
      page: { pageNumber: 1, pageSize: 10 },
    });
    expect(searchResult.success).toBe(true);
    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'auth',
      source: 'history-transcript',
    }));

    const snippetResult = await invoke(IPC_CHANNELS.HISTORY_EXPAND_SNIPPETS, {
      entryId: 'entry-1',
      query: 'auth',
    });
    expect(snippetResult.success).toBe(true);
    expect(snippets.expandSnippetsOnDemand).toHaveBeenCalledWith('entry-1', 'auth');
  });

  it('routes resume latest, fork, and fallback actions through InstanceManager.restoreFromHistory', async () => {
    getEntries.mockReturnValue([{ id: 'latest-entry' }]);
    const restoreFromHistory = vi.fn().mockResolvedValue({
      instanceId: 'restored-1',
      restoredMessages: [],
      restoreMode: 'replay-fallback',
      sessionId: 'session-1',
      historyThreadId: 'thread-1',
    });
    const instanceManager = {
      restoreFromHistory,
      getInstance: vi.fn().mockReturnValue({
        id: 'live-1',
        sessionId: 'live-session',
        historyThreadId: 'live-thread',
      }),
    } as unknown as InstanceManager;

    registerResumeHandlers({ instanceManager });

    const latest = await invoke(IPC_CHANNELS.RESUME_LATEST, { workingDirectory: '/repo' });
    expect(latest.success).toBe(true);
    expect(restoreFromHistory).toHaveBeenCalledWith('latest-entry', { workingDirectory: '/repo' });

    const fork = await invoke(IPC_CHANNELS.RESUME_FORK_NEW, { entryId: 'entry-1' });
    expect(fork.success).toBe(true);
    expect(restoreFromHistory).toHaveBeenCalledWith('entry-1', {
      forkAs: {
        sessionId: expect.any(String),
        historyThreadId: expect.any(String),
      },
    });

    const fallback = await invoke(IPC_CHANNELS.RESUME_RESTORE_FALLBACK, { entryId: 'entry-2' });
    expect(fallback.success).toBe(true);
    expect(restoreFromHistory).toHaveBeenCalledWith('entry-2', { forceFallback: true });

    const live = await invoke(IPC_CHANNELS.RESUME_SWITCH_TO_LIVE, { instanceId: 'live-1' });
    expect(live).toMatchObject({
      success: true,
      data: {
        instanceId: 'live-1',
        sessionId: 'live-session',
        historyThreadId: 'live-thread',
      },
    });
  });

  it('evaluates workflow transition policy and natural-language suggestions', async () => {
    const manager = {
      getTemplate: vi.fn().mockReturnValue({
        id: 'feature-dev',
        name: 'Feature Dev',
        description: '',
        category: 'development',
        phases: [],
      }),
      getActiveExecutionForInstance: vi.fn().mockReturnValue(undefined),
      getExecution: vi.fn(),
    } as unknown as WorkflowManager;
    const classifier = {
      classify: vi.fn().mockReturnValue({
        size: 'medium',
        surface: 'template-confirm',
        suggestedRef: 'wf-review',
        matchedSignals: ['workflow-keyword-review'],
      }),
    };

    registerWorkflowHandlers({ workflowManager: manager, classifier });

    const transition = await invoke(IPC_CHANNELS.WORKFLOW_CAN_TRANSITION, {
      instanceId: 'inst-1',
      templateId: 'feature-dev',
      source: 'manual-ui',
    });
    expect(transition).toMatchObject({
      success: true,
      data: {
        policy: { kind: 'allow' },
        requestedTemplateId: 'feature-dev',
      },
    });

    const suggestion = await invoke(IPC_CHANNELS.WORKFLOW_NL_SUGGEST, {
      promptText: 'review auth.ts',
      provider: 'codex',
    });
    expect(suggestion).toMatchObject({
      success: true,
      data: {
        surface: 'template-confirm',
        suggestedRef: 'wf-review',
      },
    });
    expect(classifier.classify).toHaveBeenCalledWith('review auth.ts', {
      provider: 'codex',
      workingDirectory: undefined,
    });
  });
});
