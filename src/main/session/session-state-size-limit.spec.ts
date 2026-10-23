import { describe, expect, it } from 'vitest';
import { assertSessionStatePayloadSize, boundSessionStateForPersistence } from './session-state-size-limit';
import { stringifyContinuityEnvelope } from './continuity-payload-envelope';
import type { SessionState } from './session-continuity.types';

const state = (contents: string[]): SessionState => ({
  instanceId: 'fixture', sessionId: 'native-fixture', accountProfileId: 'fixture-account',
  conversationHistoryOriginKnown: true, conversationHistoryComplete: true,
  conversationHistory: contents.map((content, index) => ({ id: `${index}`, role: 'assistant', timestamp: index, content })),
} as SessionState);

describe('session state byte cap', () => {
  it('keeps the newest whole messages and clears completeness without mutating the source', () => {
    const original = state(['old'.repeat(500), 'middle'.repeat(100), 'newest']);
    const bounded = boundSessionStateForPersistence(original, 2048);
    expect(bounded.conversationHistory.at(-1)?.content).toBe('newest');
    expect(bounded.conversationHistory.map(entry => entry.id)).not.toContain('0');
    expect(bounded.conversationHistoryComplete).toBe(false);
    expect(bounded.conversationHistoryOriginKnown).toBe(false);
    expect(bounded.sessionId).toBe('native-fixture');
    expect(bounded.accountProfileId).toBe('fixture-account');
    expect(original.conversationHistory).toHaveLength(3);
    expect(original.conversationHistoryComplete).toBe(true);
    expect(Buffer.byteLength(stringifyContinuityEnvelope(false, JSON.stringify(bounded)))).toBeLessThanOrEqual(2048);
  });

  it('retains a bounded end of a single oversized entry with escaped and Unicode text', () => {
    const bounded = boundSessionStateForPersistence(state(['\\\"\n😀'.repeat(5000) + 'recent tail']), 4096);
    expect(bounded.conversationHistory.at(-1)?.content).toContain('recent tail');
    expect(Buffer.byteLength(stringifyContinuityEnvelope(false, JSON.stringify(bounded)))).toBeLessThanOrEqual(4096);
    expect(bounded.conversationHistoryComplete).toBe(false);
  });

  it('preserves complete small states and refuses oversized non-transcript data', () => {
    const original = state(['small']);
    expect(boundSessionStateForPersistence(original, 4096)).toBe(original);
    expect(() => boundSessionStateForPersistence({ ...original, systemPrompt: 'x'.repeat(5000) }, 4096)).toThrow('metadata');
    expect(assertSessionStatePayloadSize('small')).toBe('small');
    expect(() => assertSessionStatePayloadSize('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('size limit');
  });
});
