import { describe, expect, it } from 'vitest';
import type { ContextUsage, Instance, SessionDiffStats } from '../../shared/types/instance.types';
import { InstanceStateManager } from './instance-state';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Session',
    provider: 'claude',
    status: 'idle',
    ...overrides,
  } as unknown as Instance;
}

describe('InstanceStateManager', () => {
  it('preserves queued context usage and diff stats when later updates omit them', () => {
    const state = new InstanceStateManager();
    const contextUsage: ContextUsage = {
      used: 100,
      total: 1000,
      percentage: 10,
    };
    const diffStats: SessionDiffStats = {
      totalAdded: 4,
      totalDeleted: 2,
      files: {
        'src/example.ts': {
          path: 'src/example.ts',
          status: 'modified',
          added: 4,
          deleted: 2,
        },
      },
    };

    state.queueUpdate('instance-1', 'busy', contextUsage, diffStats);
    state.queueUpdate('instance-1', 'idle');

    expect(
      (state as unknown as { pendingUpdates: Map<string, unknown> }).pendingUpdates.get('instance-1')
    ).toMatchObject({
      instanceId: 'instance-1',
      status: 'idle',
      contextUsage,
      diffStats,
    });

    state.destroy();
  });

  it('LT-160: writes waitReason directly onto the live instance, not only the pending broadcast', () => {
    const state = new InstanceStateManager();
    state.setInstance(makeInstance());

    state.queueUpdate(
      'instance-1',
      'idle',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { kind: 'quota-park', provider: 'claude', resumeAt: Date.now() + 60_000 },
    );

    // The synchronous, main-process source of truth (what SessionAdmissionService
    // and the mobile input queue read) must see the wait reason immediately —
    // not only the batched renderer-broadcast payload, which flushes later.
    expect(state.getInstance('instance-1')?.waitReason).toMatchObject({ kind: 'quota-park', provider: 'claude' });

    // `null` clears it on both the live object and the pending broadcast.
    state.queueUpdate('instance-1', 'idle', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
    expect(state.getInstance('instance-1')?.waitReason).toBeUndefined();

    state.destroy();
  });
});
