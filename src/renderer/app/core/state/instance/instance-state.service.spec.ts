import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';

function instance(id: string, historyThreadId = `thread-${id}`): Instance {
  return {
    id,
    displayName: id,
    createdAt: 1,
    historyThreadId,
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'codex',
    status: 'idle',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: 2,
    providerSessionId: `session-${id}`,
    sessionId: `session-${id}`,
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    launchMode: 'orchestrated',
    outputBuffer: [],
    hasUnreadCompletion: false,
  };
}

describe('InstanceStateService unread completion persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keeps an unread completion through a snapshot refresh and a new renderer store', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('unread'));
    first.updateInstance('unread', { hasUnreadCompletion: true });

    first.setInstances(new Map([['unread', instance('unread')]]));
    expect(first.getInstance('unread')?.hasUnreadCompletion).toBe(true);

    const restarted = new InstanceStateService();
    restarted.setInstances(new Map([['unread', instance('unread')]]));
    expect(restarted.getInstance('unread')?.hasUnreadCompletion).toBe(true);
  });

  it('keeps an unread completion when an instance-created event restores the row', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('restored'));
    first.updateInstance('restored', { hasUnreadCompletion: true });

    const restarted = new InstanceStateService();
    restarted.addInstance(instance('restored'));
    expect(restarted.getInstance('restored')?.hasUnreadCompletion).toBe(true);
  });

  it('does not restore the dot after the session is viewed', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('viewed'));
    first.updateInstance('viewed', { hasUnreadCompletion: true });

    first.updateInstance('viewed', { hasUnreadCompletion: false });

    const restarted = new InstanceStateService();
    restarted.setInstances(new Map([['viewed', instance('viewed')]]));
    expect(restarted.getInstance('viewed')?.hasUnreadCompletion).toBe(false);
  });

  it('keeps the dot when the instance is removed without being viewed', () => {
    // Shutdown runs terminateAll(), which removes every instance. Clearing the
    // marker there is what erased every dot across a restart, so removal must
    // leave it alone — the thread survives as history and keeps the marker.
    const first = new InstanceStateService();
    first.addInstance(instance('removed'));
    first.updateInstance('removed', { hasUnreadCompletion: true });

    first.removeInstance('removed');

    expect(first.isThreadUnread('thread-removed')).toBe(true);
  });

  it('carries the dot across a restore that mints a new instance id', () => {
    // Restore/fork/crash-recovery all mint a fresh instance id for the same
    // thread. Keying by instance id stranded the marker in that case too.
    const first = new InstanceStateService();
    first.addInstance(instance('old-id', 'thread-shared'));
    first.updateInstance('old-id', { hasUnreadCompletion: true });

    const restarted = new InstanceStateService();
    restarted.addInstance(instance('new-id', 'thread-shared'));
    expect(restarted.getInstance('new-id')?.hasUnreadCompletion).toBe(true);
  });

  it('does not leak one thread marker onto another', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('a', 'thread-a'));
    first.updateInstance('a', { hasUnreadCompletion: true });

    const restarted = new InstanceStateService();
    restarted.addInstance(instance('b', 'thread-b'));
    expect(restarted.getInstance('b')?.hasUnreadCompletion).toBe(false);
    expect(first.isThreadUnread('thread-a')).toBe(true);
  });

  it('clears the thread marker by thread id so history rows can drop the dot', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('live', 'thread-shared'));
    first.updateInstance('live', { hasUnreadCompletion: true });

    first.clearThreadUnread('thread-shared');

    expect(first.isThreadUnread('thread-shared')).toBe(false);
  });
});
