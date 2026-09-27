import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { isQuietProviderCompactionMarker } from './display-item-system-events';

function system(metadata: Record<string, unknown>): OutputMessage {
  return { id: 'm', type: 'system', timestamp: 1, content: 'notice', metadata };
}

describe('isQuietProviderCompactionMarker', () => {
  // xqs4fg7sl's transcript was three rows per compaction; the boundary row alone says it happened.
  it('hides the start and successful finish notices of a provider compaction', () => {
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'started' }))).toBe(true);
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', providerCompactionOutcome: 'settled' })))
      .toBe(true);
  });

  it('keeps the boundary row and every failed outcome visible', () => {
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', threadCompacted: true }))).toBe(false);
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', isCompactionBoundary: true }))).toBe(false);
    for (const outcome of ['timed-out', 'stalled', 'aborted', 'failed', 'cancelled']) {
      expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', providerCompactionOutcome: outcome })))
        .toBe(false);
    }
    expect(isQuietProviderCompactionMarker({ ...system({ providerCompaction: 'started' }), type: 'error' })).toBe(false);
    expect(isQuietProviderCompactionMarker(system({}))).toBe(false);
  });
});
