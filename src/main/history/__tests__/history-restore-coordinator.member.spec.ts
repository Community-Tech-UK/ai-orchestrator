/**
 * A phone-app member's conversation comes back as theirs, on their own worker,
 * and never falls back to running on this Mac when that worker is offline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { MobileMemberProfile } from '../../../shared/types/mobile-gateway.types';
import type { InstanceManager } from '../../instance/instance-manager';

const { members } = vi.hoisted(() => ({ members: new Map<string, unknown>() }));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ sessionHandoffStateEnabled: false }) }),
}));
vi.mock('../../mobile-gateway/mobile-device-registry', () => ({
  getMobileDeviceRegistry: () => ({ getMember: (profileId: string) => members.get(profileId) }),
}));

import { HistoryRestoreCoordinator, HistoryRestoreError } from '../history-restore-coordinator';

const member: MobileMemberProfile = {
  profileId: 'member-1',
  name: 'Second person',
  createdAt: 1,
  session: {
    workerNodeId: 'her-worker',
    workingDirectory: '/home/member/work',
    allowedAccountProfileIds: ['acct-claude'],
  },
};

function conversation(overrides: Partial<ConversationData['entry']> = {}): ConversationData {
  const message = (id: string, type: OutputMessage['type'], content: string) =>
    ({ id, type, content, timestamp: Date.now() }) as OutputMessage;
  return {
    entry: {
      id: 'entry-1',
      displayName: 'Her thread',
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 1_000,
      workingDirectory: '/home/member/work',
      messageCount: 2,
      firstUserMessage: 'Plan my week',
      lastUserMessage: 'Continue',
      status: 'completed',
      originalInstanceId: 'old-instance',
      parentId: null,
      sessionId: 'native-session',
      historyThreadId: 'history-thread',
      provider: 'claude',
      executionLocation: { type: 'remote', nodeId: 'her-worker' },
      mobileProfileId: 'member-1',
      ...overrides,
    },
    messages: [message('u1', 'user', 'Plan my week'), message('u2', 'user', 'Continue')],
  };
}

describe('HistoryRestoreCoordinator for a phone-app member', () => {
  const loadConversation = vi.fn();
  const createInstance = vi.fn();
  let nodeReachable = true;
  let coordinator: HistoryRestoreCoordinator;
  let manager: InstanceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    members.clear();
    members.set('member-1', member);
    nodeReachable = true;
    loadConversation.mockResolvedValue(conversation());
    createInstance.mockImplementation(async (config: { initialOutputBuffer?: OutputMessage[] }) => ({
      id: 'restored', status: 'idle', outputBuffer: config.initialOutputBuffer ?? [], readyPromise: Promise.resolve(),
    }) as unknown as Instance);
    manager = {
      createInstance,
      getInstance: () => undefined,
      terminateInstance: vi.fn(),
      queueContinuityPreamble: vi.fn(),
    } as unknown as InstanceManager;
    coordinator = new HistoryRestoreCoordinator({
      history: () => ({ loadConversation, markNativeResumeFailed: vi.fn() }),
      outputStorage: () => ({ storeMessages: vi.fn().mockResolvedValue(undefined) }),
      isRemoteNodeReachable: () => nodeReachable,
      postSpawnTimeoutMs: 0,
      pollIntervalMs: 1,
    });
  });

  it('refuses to restore when their worker is offline, and starts nothing on this Mac', async () => {
    nodeReachable = false;

    await expect(coordinator.restore(manager, 'entry-1')).rejects.toMatchObject({
      name: HistoryRestoreError.name,
      code: 'MEMBER_NODE_UNAVAILABLE',
    });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('keeps the conversation theirs, on their worker, on their accounts and without approval prompts', async () => {
    await coordinator.restore(manager, 'entry-1');

    expect(createInstance).toHaveBeenCalled();
    for (const [config] of createInstance.mock.calls as [Record<string, unknown>][]) {
      expect(config).toMatchObject({
        forceNodeId: 'her-worker',
        yoloMode: true,
        allowedAccountProfileIds: ['acct-claude'],
        metadata: { mobileProfileId: 'member-1' },
      });
    }
  });

  it('restores into the folder currently saved for them, not the one the conversation was archived in', async () => {
    loadConversation.mockResolvedValue(conversation({ workingDirectory: '/home/member/old-folder' }));

    await coordinator.restore(manager, 'entry-1');

    expect(createInstance).toHaveBeenCalled();
    for (const [config] of createInstance.mock.calls as [Record<string, unknown>][]) {
      expect(config['workingDirectory']).toBe('/home/member/work');
    }
  });

  it('refuses a conversation that ran on a computer no longer set up for its person, and starts nothing', async () => {
    members.set('member-1', { ...member, session: { ...member.session!, workerNodeId: 'another-worker' } });

    await expect(coordinator.restore(manager, 'entry-1')).rejects.toMatchObject({ code: 'MEMBER_COMPUTER_CHANGED' });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('refuses a conversation whose person has no computer of their own set up', async () => {
    members.set('member-1', { ...member, session: undefined });

    await expect(coordinator.restore(manager, 'entry-1')).rejects.toMatchObject({ code: 'MEMBER_NOT_SET_UP' });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('restores a removed person\'s conversation as the owner\'s, as before', async () => {
    members.clear();
    nodeReachable = false;

    await coordinator.restore(manager, 'entry-1');

    const config = createInstance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['metadata']).toBeUndefined();
    expect(config['yoloMode']).toBeUndefined();
  });

  it("leaves the owner's conversations alone", async () => {
    loadConversation.mockResolvedValue(conversation({ mobileProfileId: undefined, executionLocation: undefined }));

    await coordinator.restore(manager, 'entry-1');

    const config = createInstance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config['metadata']).toBeUndefined();
  });
});
