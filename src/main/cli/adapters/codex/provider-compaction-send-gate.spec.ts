import { describe, expect, it, vi } from 'vitest';

import type { CodexContextCostController } from './context-cost-controller';
import { awaitProviderCompactionSettled } from './provider-compaction-send-gate';

describe('provider compaction send gate', () => {
  it('uses collision-resistant ids for simultaneous paused notices', async () => {
    const emitted: Array<{ id: string }> = [];
    const controller = {
      isCompactionRunning: () => true,
      awaitCompactionSettled: vi.fn(async () => 'stalled' as const),
    } as unknown as CodexContextCostController;

    const first = awaitProviderCompactionSettled({ controller, emitPaused: (message) => emitted.push(message) });
    const second = awaitProviderCompactionSettled({ controller, emitPaused: (message) => emitted.push(message) });

    await expect(first).rejects.toThrow('Codex is still compacting');
    await expect(second).rejects.toThrow('Codex is still compacting');
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map(({ id }) => id)).size).toBe(2);
  });
});
