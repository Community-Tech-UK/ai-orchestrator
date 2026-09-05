import { describe, expect, it } from 'vitest';
import { CodexUsageAccounting } from './usage-accounting';

const raw = (input: number, output: number, cached = 0, reasoning = 0) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: reasoning, totalTokens: input + output });

describe('CodexUsageAccounting protocol fallbacks', () => {
  it('counts identical last-only calls in distinct child turns but preserves ongoing-turn deduplication', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.beginNativeTurn('child', 'one');
    tracker.observe('child', undefined, raw(100, 20), true);
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    tracker.beginTurn('root');
    tracker.beginNativeTurn('child', 'one');
    tracker.observe('child', undefined, raw(100, 20), true);
    expect(tracker.take('gpt-6-astra')).toBeUndefined();
    tracker.beginNativeTurn('child', 'two');
    tracker.observe('child', undefined, raw(100, 20), true);
    tracker.beginNativeTurn('child', 'two');
    tracker.observe('child', undefined, raw(100, 20), true);
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    tracker.fallback('child', raw(100, 20), true, 'two');
    tracker.beginNativeTurn('child', 'two');
    tracker.observe('child', raw(200, 40), raw(100, 20), true);
    expect(tracker.take('gpt-6-astra')).toBeUndefined();
    expect(tracker.cumulativeTokens).toBe(240);
  });

  it('keeps child native-turn receipts independent of root delivery boundaries', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.beginNativeTurn('child', 'child-1');
    tracker.observe('child', raw(100, 20), undefined, true);
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    tracker.beginTurn('root');
    tracker.observe('child', raw(150, 30), undefined, true);
    tracker.fallback('child', raw(150, 30), true, 'child-1');
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
    tracker.beginTurn('root');
    tracker.beginNativeTurn('child', 'child-2');
    tracker.fallback('child', raw(150, 30), true, 'child-1');
    tracker.fallback('child', raw(50, 10), true, 'child-2');
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
    tracker.fallback('child', raw(150, 30), true, 'child-1');
    expect(tracker.take('gpt-6-astra')).toBeUndefined();
    expect(tracker.cumulativeTokens).toBe(240);
  });

  it.each(['root', 'child'])('reconciles first cumulative totals with earlier last-only %s calls', thread => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe(thread, {}, raw(100, 20), thread === 'child');
    tracker.observe(thread, raw(200, 40), raw(100, 20), thread === 'child');
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(240);
    expect(tracker.cumulativeTokens).toBe(240);
  });

  it('does not charge a resumed last-only call again when its first historical total arrives', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root', true);
    tracker.observe('root', {}, raw(100, 20));
    tracker.observe('root', raw(1100, 220), raw(100, 20));
    expect(tracker.take('gpt-6-astra')).toMatchObject({ totalTokens: 120, isEstimated: true });
    tracker.beginTurn('root', true);
    tracker.observe('root', raw(1200, 240), raw(100, 20));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    expect(tracker.cumulativeTokens).toBe(240);
  });

  it('preserves unbaselined resume deduplication across an interrupted turn boundary', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root', true);
    tracker.observe('root', {}, raw(100, 20));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    tracker.beginTurn('root', true);
    tracker.observe('root', raw(1100, 220), raw(100, 20));
    expect(tracker.take('gpt-6-astra')).toBeUndefined();
    expect(tracker.cumulativeTokens).toBe(120);
  });

  it('does not reset a native turn baseline when turn/started is repeated', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.beginNativeTurn('root', 'turn-1');
    tracker.observe('root', raw(100, 20));
    tracker.beginNativeTurn('root', 'turn-1');
    tracker.fallback('root', raw(100, 20));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
  });
  it('accounts successive completion-only child turns separately within one root turn', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.beginNativeTurn('child');
    tracker.fallback('child', raw(100, 20), true);
    tracker.beginNativeTurn('child');
    tracker.fallback('child', raw(100, 20), true);
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(240);
  });
  it('adds a completion aggregate remainder when the final usage notification was missed', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(100, 20));
    tracker.fallback('root', raw(200, 40));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(240);
    tracker.beginTurn('root');
    tracker.observe('root', raw(250, 50), raw(50, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
  });

  it('keeps the detailed baseline across total-only updates without double-counting their calls', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(100, 20));
    tracker.observe('root', { totalTokens: 180 }, raw(50, 10));
    tracker.observe('root', raw(200, 40), raw(50, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(240);
    expect(tracker.cumulativeTokens).toBe(240);
  });
  it('counts empty-total last-only notifications conservatively and accepts a reliable completion aggregate', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', {}, raw(100, 20, 80, 4));
    tracker.observe('root', {}, raw(100, 20, 80, 4));
    tracker.fallback('root', raw(300, 40, 180, 10));
    expect(tracker.take('gpt-6-astra')).toMatchObject({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 180, reasoningTokens: 10, totalTokens: 340, isEstimated: true });
    tracker.beginTurn('root');
    tracker.observe('root', raw(400, 60, 260, 14), raw(100, 20, 80, 4));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    expect(tracker.cumulativeTokens).toBe(460);
  });

  it('aligns completion fallback after last-only calls against a known earlier baseline', () => {
    const tracker = new CodexUsageAccounting();
    tracker.seed('root', raw(100, 20));
    tracker.beginTurn('root');
    tracker.observe('root', {}, raw(50, 10));
    tracker.fallback('root', raw(100, 20));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    tracker.beginTurn('root');
    tracker.observe('root', raw(250, 50), raw(50, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
    expect(tracker.cumulativeTokens).toBe(180);
  });

  it.each([Number.NaN, Infinity, -1, 'malformed'])('does not overwrite a known baseline with invalid total %s', totalTokens => {
    const tracker = new CodexUsageAccounting();
    tracker.seed('root', raw(100, 20));
    tracker.beginTurn('root');
    tracker.observe('root', { totalTokens });
    tracker.observe('root', raw(150, 30), raw(50, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
  });

  it('does not let a repeated old snapshot suppress new completion-only usage', () => {
    const tracker = new CodexUsageAccounting();
    tracker.seed('root', raw(100, 20));
    tracker.beginTurn('root');
    tracker.observe('root', raw(100, 20));
    tracker.fallback('root', raw(50, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
    expect(tracker.cumulativeTokens).toBe(60);
    tracker.beginTurn('root');
    tracker.observe('root', raw(180, 40), raw(30, 10));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(40);
  });

  it('never charges drained partial spend twice when more usage arrives before teardown', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(100, 20));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(120);
    expect(tracker.take('gpt-6-astra')).toBeUndefined();
    tracker.observe('root', raw(150, 30));
    expect(tracker.take('gpt-6-astra')?.totalTokens).toBe(60);
  });

  it('clamps native subset counters so malformed cache/reasoning cannot double-count', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(100, 20, 500, 200));
    expect(tracker.take('gpt-6-astra')).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 100, reasoningTokens: 20, totalTokens: 120 });
  });
});
