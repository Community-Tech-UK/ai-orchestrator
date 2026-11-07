import { describe, expect, it } from 'vitest';
import { resolveCostSessionLabel } from './cost-session-label';
describe('cost session labels', () => {
  it('prefers a live title and resolves ended names with renames ahead of AI titles', () => {
    expect(resolveCostSessionLabel('s', 'i', [{ id: 'i', sessionId: 's', displayName: 'Live' }], [])).toMatchObject({ title: 'Live', state: 'open', target: 'i' });
    expect(resolveCostSessionLabel('s', 'i', [], [{ id: 'h', sessionId: 's', displayName: 'Renamed', aiTitle: 'AI', isRenamed: true }]))
      .toMatchObject({ title: 'Renamed', state: 'ended', target: 'h' });
    expect(resolveCostSessionLabel('s', 'i', [], [{ id: 'h', originalInstanceId: 'i', displayName: 'Fallback', aiTitle: 'AI' }]).title).toBe('AI');
    expect(resolveCostSessionLabel('s', undefined, [], [])).toEqual({ title: 'Ended session', state: 'unknown', target: null });
  });
});
