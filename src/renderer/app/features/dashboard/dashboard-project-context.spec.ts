import { describe, expect, it } from 'vitest';
import { resolveDashboardProjectContext } from './dashboard-project-context';

const scratchDir = '/Users/suas/.ai-orchestrator/scratch';

function resolve(overrides: Partial<Parameters<typeof resolveDashboardProjectContext>[0]> = {}) {
  return resolveDashboardProjectContext({
    selectedInstance: null,
    selectedChat: null,
    previewConversation: null,
    draftWorkingDirectory: null,
    draftNodeId: null,
    isScratch: (workingDirectory) => workingDirectory === scratchDir,
    ...overrides,
  });
}

describe('resolveDashboardProjectContext', () => {
  it('uses the selected local project instance', () => {
    expect(resolve({
      selectedInstance: {
        workingDirectory: ' /work/project ',
        executionLocation: { type: 'local' },
      },
      draftWorkingDirectory: '/work/stale-draft',
    })).toEqual({
      workingDirectory: '/work/project',
      nodeId: null,
    });
  });

  it('preserves the selected remote project instance node', () => {
    expect(resolve({
      selectedInstance: {
        workingDirectory: '/remote/project',
        executionLocation: { type: 'remote', nodeId: 'node-1' },
      },
    })).toEqual({
      workingDirectory: '/remote/project',
      nodeId: 'node-1',
    });
  });

  it('does not fall through to a stale project draft from a selected scratch instance', () => {
    expect(resolve({
      selectedInstance: {
        workingDirectory: scratchDir,
        executionLocation: { type: 'local' },
      },
      draftWorkingDirectory: '/work/stale-draft',
      draftNodeId: 'node-1',
    })).toBeNull();
  });

  it('does not fall through to a stale project draft from a selected scratch chat', () => {
    expect(resolve({
      selectedChat: { currentCwd: scratchDir },
      draftWorkingDirectory: '/work/stale-draft',
      draftNodeId: 'node-1',
    })).toBeNull();
  });

  it('does not fall through to a stale project draft while selected chat detail is loading', () => {
    expect(resolve({
      selectedChat: { currentCwd: null },
      draftWorkingDirectory: '/work/stale-draft',
      draftNodeId: 'node-1',
    })).toBeNull();
  });

  it('uses a selected project chat', () => {
    expect(resolve({
      selectedChat: { currentCwd: '/work/chat-project' },
      draftWorkingDirectory: '/work/stale-draft',
    })).toEqual({
      workingDirectory: '/work/chat-project',
      nodeId: null,
    });
  });

  it('uses a selected history preview project', () => {
    expect(resolve({
      previewConversation: { workingDirectory: '/work/history-project' },
      draftWorkingDirectory: '/work/stale-draft',
    })).toEqual({
      workingDirectory: '/work/history-project',
      nodeId: null,
    });
  });

  it('preserves a selected remote history preview node', () => {
    expect(resolve({
      previewConversation: {
        workingDirectory: '/remote/history-project',
        executionLocation: { type: 'remote', nodeId: 'node-history' },
      },
      draftWorkingDirectory: '/work/stale-draft',
    })).toEqual({
      workingDirectory: '/remote/history-project',
      nodeId: 'node-history',
    });
  });

  it('uses the active draft only when there is no visible selection', () => {
    expect(resolve({
      draftWorkingDirectory: '/work/draft-project',
      draftNodeId: 'node-2',
    })).toEqual({
      workingDirectory: '/work/draft-project',
      nodeId: 'node-2',
    });
  });

  it('ignores a scratch draft', () => {
    expect(resolve({
      draftWorkingDirectory: scratchDir,
      draftNodeId: 'node-2',
    })).toBeNull();
  });
});
