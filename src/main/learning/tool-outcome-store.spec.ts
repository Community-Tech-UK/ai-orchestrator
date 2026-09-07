/**
 * LT-196: the side store that keeps tool-outcome records out of the visible
 * transcript. See `tool-outcome-store.ts` for why they are not in
 * `instance.outputBuffer`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  MAX_TOOL_OUTCOMES_PER_INSTANCE,
  MAX_TRACKED_INSTANCES,
  _resetToolOutcomeStoreForTesting,
  clearToolOutcomes,
  getToolOutcomes,
  recordToolOutcome,
} from './tool-outcome-store';

function outcome(id: string, isError = true): OutputMessage {
  return {
    id,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    type: 'tool_outcome',
    content: isError ? 'boom' : '',
    metadata: { tool_use_id: `toolu_${id}`, is_error: isError },
  };
}

describe('tool-outcome-store', () => {
  beforeEach(() => _resetToolOutcomeStoreForTesting());

  it('returns an empty list for an instance with no records', () => {
    expect(getToolOutcomes('nobody')).toEqual([]);
  });

  it('records in order and keeps instances separate', () => {
    recordToolOutcome('a', outcome('1'));
    recordToolOutcome('b', outcome('2'));
    recordToolOutcome('a', outcome('3'));

    expect(getToolOutcomes('a').map((m) => m.id)).toEqual(['1', '3']);
    expect(getToolOutcomes('b').map((m) => m.id)).toEqual(['2']);
  });

  it('clears one instance without touching another', () => {
    recordToolOutcome('a', outcome('1'));
    recordToolOutcome('b', outcome('2'));

    clearToolOutcomes('a');

    expect(getToolOutcomes('a')).toEqual([]);
    expect(getToolOutcomes('b')).toHaveLength(1);
  });

  it('caps the number of tracked instances, evicting the oldest', () => {
    // Records are normally dropped when their instance archives. This is the
    // backstop for a crash, a never-archived instance, or a future teardown
    // path that forgets to clear — without it the map grows for the app's life.
    for (let i = 0; i < MAX_TRACKED_INSTANCES + 3; i++) {
      recordToolOutcome(`inst-${i}`, outcome('1'));
    }

    // The three oldest were evicted; the newest are all still held.
    expect(getToolOutcomes('inst-0')).toEqual([]);
    expect(getToolOutcomes('inst-2')).toEqual([]);
    expect(getToolOutcomes('inst-3')).toHaveLength(1);
    expect(getToolOutcomes(`inst-${MAX_TRACKED_INSTANCES + 2}`)).toHaveLength(1);
  });

  it('caps per instance, dropping oldest first', () => {
    // A long session must not accumulate unboundedly; a correction pair is
    // always recent, so the oldest records are the safe ones to lose.
    for (let i = 0; i < MAX_TOOL_OUTCOMES_PER_INSTANCE + 5; i++) {
      recordToolOutcome('a', outcome(String(i)));
    }

    const held = getToolOutcomes('a');
    expect(held).toHaveLength(MAX_TOOL_OUTCOMES_PER_INSTANCE);
    expect(held[0]?.id).toBe('5');
    expect(held.at(-1)?.id).toBe(String(MAX_TOOL_OUTCOMES_PER_INSTANCE + 4));
  });
});
