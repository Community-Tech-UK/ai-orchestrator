import { describe, expect, it } from 'vitest';
import { retrievedNotesUsage } from './retrieved-notes-usage';
describe('retrieved-note attribution', () => {
  it('counts immediate and delivered notes on one user turn once and keeps unknown measurements unknown', () => {
    const user = { id: 'user', type: 'user' as const, timestamp: 1, content: 'Continue',
      metadata: { rlmContext: { injected: true, tokens: 50 }, retrievedContextDeliveries: { delivery: 120 } } };
    expect(retrievedNotesUsage([user, user])).toEqual({ times: 1, tokens: 170 });
    expect(retrievedNotesUsage([{ ...user, metadata: { retrievedContextDeliveries: { delivery: null } } }]))
      .toEqual({ times: 1, tokens: null });
  });
  it('counts enriched user messages once and sums only their actual metadata tokens', () => {
    expect(retrievedNotesUsage([
      { id: 'a', type: 'user', timestamp: 0, content: '', metadata: { rlmContext: { tokens: 100 }, unifiedMemoryContext: { tokens: 200 }, indexedCodebaseContext: { tokens: 300 } } },
      { id: 'b', type: 'assistant', timestamp: 0, content: '', metadata: { rlmContext: { tokens: 999 } } },
      { id: 'c', type: 'user', timestamp: 0, content: '', metadata: { rlmContext: { tokens: NaN } } },
    ])).toEqual({ times: 1, tokens: 600 });
  });
});
