import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Instance } from '../../../shared/types/instance.types';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-snippets',
    displayName: 'Snippet Thread',
    createdAt: 100,
    historyThreadId: 'thread-snippets',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: {
      enabled: false,
      state: 'off',
    },
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: 200,
    processId: null,
    providerSessionId: 'session-snippets',
    sessionId: 'session-snippets',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    currentModel: 'opus',
    outputBuffer: [
      {
        id: 'message-user-1',
        type: 'user',
        content: 'we have a regression in the auth flow',
        timestamp: 101,
      },
      {
        id: 'message-assistant-1',
        type: 'assistant',
        content: 'the session refresh path broke when the token cache changed',
        timestamp: 102,
      },
    ],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    ...overrides,
  };
}

describe('HistoryManager.archiveInstance snippets', () => {
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-manager-snippets-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) => {
          if (name === 'userData') {
            return userDataDir;
          }

          throw new Error(`Unexpected path lookup: ${name}`);
        }),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.resetModules();
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('writes precomputed snippets onto archived entries', async () => {
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    await manager.archiveInstance(makeInstance());

    const entry = manager.getEntries({ workingDirectory: '/tmp/project' })[0];
    expect(entry?.snippets?.length).toBeGreaterThan(0);
    expect(entry?.snippets?.[0]).toMatchObject({
      position: expect.any(Number),
      excerpt: expect.any(String),
      score: expect.any(Number),
    });
  });
});
