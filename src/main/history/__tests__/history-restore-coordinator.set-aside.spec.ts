/**
 * The Sort out agent (started from the Set aside tab of the Plan Queue page) keeps its Plan Queue tools when it is
 * reopened from History, which is how a session comes back after Harness restarts. A fork is a new conversation, so it
 * gets no tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { MobileMemberProfile } from '../../../shared/types/mobile-gateway.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { setAsideFolderOf } from '../../../shared/utils/plan-queue-set-aside-agent';

const { members } = vi.hoisted(() => ({ members: new Map<string, unknown>() }));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ sessionHandoffStateEnabled: false }) }),
}));
vi.mock('../../mobile-gateway/mobile-device-registry', () => ({
  getMobileDeviceRegistry: () => ({ getMember: (profileId: string) => members.get(profileId) }),
}));

import { HistoryRestoreCoordinator } from '../history-restore-coordinator';

const FOLDER = '/work/project';

function conversation(overrides: Partial<ConversationData['entry']> = {}): ConversationData {
  const message = (id: string, type: OutputMessage['type'], content: string) =>
    ({ id, type, content, timestamp: Date.now() }) as OutputMessage;
  return {
    entry: {
      id: 'entry-1',
      displayName: 'Sort out set-aside jobs',
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 1_000,
      workingDirectory: FOLDER,
      messageCount: 2,
      firstUserMessage: 'Sort out the set-aside jobs',
      lastUserMessage: 'Continue',
      status: 'completed',
      originalInstanceId: 'old-instance',
      parentId: null,
      sessionId: 'native-session',
      historyThreadId: 'history-thread',
      provider: 'claude',
      planQueueSetAsideFolder: FOLDER,
      ...overrides,
    },
    messages: [message('u1', 'user', 'Sort out the set-aside jobs'), message('u2', 'user', 'Continue')],
  };
}

describe('HistoryRestoreCoordinator for the Sort out agent', () => {
  const loadConversation = vi.fn();
  const createInstance = vi.fn();
  let coordinator: HistoryRestoreCoordinator;
  let manager: InstanceManager;

  const configs = () => createInstance.mock.calls.map(([config]) => config as { metadata?: Record<string, unknown> });

  beforeEach(() => {
    vi.clearAllMocks();
    members.clear();
    loadConversation.mockResolvedValue(conversation());
    let restored: Instance | undefined;
    createInstance.mockImplementation(async (config: { initialOutputBuffer?: OutputMessage[] }) => {
      restored = {
        id: 'restored', status: 'idle', outputBuffer: config.initialOutputBuffer ?? [], readyPromise: Promise.resolve(),
      } as unknown as Instance;
      return restored;
    });
    // The provider confirms it resumed the same session, so a native resume is accepted.
    const confirmed = {
      getResumeAttemptResult: () => ({
        source: 'native' as const, confirmed: true, requestedSessionId: 'native-session', actualSessionId: 'native-session',
      }),
    };
    manager = {
      createInstance,
      getInstance: (id: string) => (id === restored?.id ? restored : undefined),
      getAdapter: (id: string) => (id === restored?.id ? confirmed : undefined),
      terminateInstance: vi.fn(),
      queueContinuityPreamble: vi.fn(),
    } as unknown as InstanceManager;
    coordinator = new HistoryRestoreCoordinator({
      history: () => ({ loadConversation, markNativeResumeFailed: vi.fn() }),
      outputStorage: () => ({ storeMessages: vi.fn().mockResolvedValue(undefined), deleteInstance: vi.fn().mockResolvedValue(undefined) }),
      isRemoteNodeReachable: () => true,
      postSpawnTimeoutMs: 0,
      pollIntervalMs: 1,
    });
  });

  it('keeps its folder when resumed natively', async () => {
    const result = await coordinator.restore(manager, 'entry-1');

    expect(result.restoreMode).toBe('native-resume');
    expect(configs()).toHaveLength(1);
    expect(setAsideFolderOf(configs()[0]!.metadata)).toBe(FOLDER);
  });

  it('keeps its folder when the conversation is replayed instead', async () => {
    const result = await coordinator.restore(manager, 'entry-1', { forceFallback: true });

    expect(result.restoreMode).not.toBe('native-resume');
    expect(configs()).toHaveLength(1);
    expect(setAsideFolderOf(configs()[0]!.metadata)).toBe(FOLDER);
  });

  it('gives a fork of the conversation no Plan Queue tools', async () => {
    await coordinator.restore(manager, 'entry-1', { forkAs: { sessionId: 'fork-session', historyThreadId: 'fork-thread' } });

    expect(configs()).toHaveLength(1);
    expect(setAsideFolderOf(configs()[0]!.metadata)).toBeUndefined();
  });

  it('keeps a phone member stamp alongside the folder', async () => {
    const member: MobileMemberProfile = {
      profileId: 'member-1',
      name: 'Second person',
      createdAt: 1,
      session: { workerNodeId: 'her-worker', workingDirectory: FOLDER, allowedAccountProfileIds: ['acct-claude'] },
    };
    members.set('member-1', member);
    loadConversation.mockResolvedValue(conversation({
      mobileProfileId: 'member-1',
      executionLocation: { type: 'remote', nodeId: 'her-worker' },
    }));

    await coordinator.restore(manager, 'entry-1');

    expect(configs()[0]).toMatchObject({
      yoloMode: true,
      metadata: { mobileProfileId: 'member-1', planQueueSetAsideFolder: FOLDER },
    });
  });

  it('gives an ordinary conversation no Plan Queue tools', async () => {
    loadConversation.mockResolvedValue(conversation({ planQueueSetAsideFolder: undefined }));

    await coordinator.restore(manager, 'entry-1');

    expect(configs()[0]!.metadata).toBeUndefined();
  });
});
