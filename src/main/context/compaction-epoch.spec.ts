import { describe, it, expect } from 'vitest';
import { CompactionEpochTracker } from './compaction-epoch';

describe('CompactionEpochTracker', () => {
  it('starts with epoch 0 turns', () => {
    const tracker = new CompactionEpochTracker();
    expect(tracker.getCurrentEpoch().epochId).toBeDefined();
    expect(tracker.getCurrentEpoch().turnCount).toBe(0);
  });

  it('increments turn count', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    expect(tracker.getCurrentEpoch().turnCount).toBe(2);
  });

  it('resets on compaction with new epoch ID', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    const oldId = tracker.getCurrentEpoch().epochId;
    tracker.onCompaction();
    expect(tracker.getCurrentEpoch().turnCount).toBe(0);
    expect(tracker.getCurrentEpoch().epochId).not.toBe(oldId);
  });

  it('records compaction history', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction();
    tracker.incrementTurn();
    tracker.onCompaction();
    const history = tracker.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].turnsBeforeCompaction).toBe(3);
    expect(history[1].turnsBeforeCompaction).toBe(1);
  });

  it('computes average turns between compactions', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction();
    expect(tracker.getAverageTurnsBetweenCompactions()).toBe(3);
  });
});
