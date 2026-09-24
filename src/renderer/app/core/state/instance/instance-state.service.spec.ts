import { beforeEach, describe, expect, it } from 'vitest';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';

function instance(id: string): Instance {
  return {
    id,
    displayName: id,
    createdAt: 1,
    historyThreadId: `thread-${id}`,
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

  it('does not restore the dot after the session is viewed or removed', () => {
    const first = new InstanceStateService();
    first.addInstance(instance('viewed'));
    first.addInstance(instance('removed'));
    first.updateInstance('viewed', { hasUnreadCompletion: true });
    first.updateInstance('removed', { hasUnreadCompletion: true });

    first.updateInstance('viewed', { hasUnreadCompletion: false });
    first.removeInstance('removed');

    const restarted = new InstanceStateService();
    restarted.setInstances(new Map([
      ['viewed', instance('viewed')],
      ['removed', instance('removed')],
    ]));
    expect(restarted.getInstance('viewed')?.hasUnreadCompletion).toBe(false);
    expect(restarted.getInstance('removed')?.hasUnreadCompletion).toBe(false);
  });
});
