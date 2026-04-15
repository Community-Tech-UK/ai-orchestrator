import { describe, expect, it } from 'vitest';
import type { ContextUsage, SessionDiffStats } from '../../shared/types/instance.types';
import { InstanceStateManager } from './instance-state';

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
});
