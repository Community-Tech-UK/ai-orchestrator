import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { BatchUpdatePayload } from '../../shared/types/ipc.types';
import { InstanceStateManager } from './instance-state';

describe('detached child state broadcasts', () => {
  afterEach(() => vi.useRealTimers());
  it('broadcasts an explicit cleared parent link on later status batches', () => {
    vi.useFakeTimers();
    const state = new InstanceStateManager();
    const batches: BatchUpdatePayload[] = [];
    state.on('batch-update', batch => batches.push(batch));
    try {
      state.setInstance({ id: 'child', status: 'busy', parentId: null } as Instance);
      state.queueUpdate('child', 'busy');
      vi.advanceTimersByTime(1000);
      expect(batches[0].updates[0]).toMatchObject({ instanceId: 'child', parentId: null });
    } finally { state.destroy(); }
  });
});
