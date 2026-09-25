import { describe, expect, it } from 'vitest';

import { buildObservedCompactionEvents } from './compaction-presentation';

describe('observed Codex compaction presentation', () => {
  it('keeps the last known occupancy as an estimate instead of reporting zero context', () => {
    const events = buildObservedCompactionEvents({
      contextWindow: 200_000,
      lastKnownUsed: 120_000,
      cumulativeTokens: 450_000,
      costEstimate: 12.5,
    });

    expect(events.context).toMatchObject({
      used: 120_000,
      total: 200_000,
      percentage: 60,
      source: 'thread-compacted',
      isEstimated: true,
    });
    expect(events.output.metadata).toMatchObject({
      threadCompacted: true,
    });
    expect(events.output.metadata).not.toHaveProperty('providerCompaction');
  });

  it('emits no occupancy reading when Codex has not reported one yet', () => {
    const events = buildObservedCompactionEvents({
      contextWindow: 200_000,
      cumulativeTokens: 450_000,
      costEstimate: 12.5,
    });

    expect(events.context).toBeNull();
    expect(events.output.content).toContain('Codex compacted');
  });
});
