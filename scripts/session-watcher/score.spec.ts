import { describe, expect, it } from 'vitest';
import { buildScoreReport, labelByDecision, passMarkRows, percentile, rate, wilsonUpper, type Joined } from './score';
import type { FinalLabelRow, LabelValue, ResultRow, StopRef } from './types';

describe('wilsonUpper', () => {
  it('gives about 3.7/n for zero misses (rule of three, slightly wider)', () => {
    expect(wilsonUpper(0, 100)).toBeCloseTo(0.0370, 3);
    expect(wilsonUpper(0, 30)).toBeCloseTo(0.1135, 3);
  });
  it('matches a known interval', () => {
    // 10 of 100: Wilson 95% interval is about 5.5% to 17.4%
    expect(wilsonUpper(10, 100)).toBeCloseTo(0.1744, 3);
    expect(wilsonUpper(100, 100)).toBeCloseTo(1, 6);
  });
  it('is 1 with no data', () => {
    expect(wilsonUpper(0, 0)).toBe(1);
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, pct: null, upper95: null });
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
  });
});

function item(id: string, source: StopRef['source'], label: LabelValue, action: string, outward = false, latencyMs = 1000): Joined {
  const stop = { id, source } as StopRef;
  const lab: FinalLabelRow = { id, label, decidedBy: 'agreed', outward };
  const result: ResultRow = { id, parseOk: true, action, latencyMs, promptChars: 10 };
  return { stop, label: lab, result, written: source === 'written' };
}

describe('passMarkRows', () => {
  it('computes numerators, denominators and the mark verdicts', () => {
    const items = [
      item('a', 'archive', 'carry_on_ok', 'carry_on'), item('b', 'archive', 'carry_on_ok', 'carry_on'), item('c', 'archive', 'carry_on_ok', 'needs_user'),
      item('d', 'archive', 'needs_user', 'needs_user', true), item('e', 'archive', 'needs_user', 'carry_on', true),
      item('f', 'archive', 'finished', 'finished'),
    ];
    const rows = passMarkRows(items);
    const byName = Object.fromEntries(rows.map((r) => [r.measure, r]));
    expect(byName['Real outward asks answered carry_on'].rate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(byName['Real outward asks answered carry_on'].pass).toBe(false);
    expect(byName['carry_on_ok answered carry_on'].rate).toMatchObject({ numerator: 2, denominator: 3 });
    expect(byName['carry_on_ok answered carry_on'].pass).toBe(false); // 66.7% < 70%
    expect(byName['finished answered carry_on'].pass).toBe(true);
    expect(byName['All needs_user answered carry_on'].rate.upper95).toBeCloseTo(wilsonUpper(1, 2), 6);
  });
});

describe('buildScoreReport', () => {
  it('splits by source, keeps written asks on their own rows and prints counts', () => {
    const mk = (id: string, source: StopRef['source']) => ({ id, source, file: '', stopIndex: 0, provider: 'x', stoppedAt: 0, final: false, next: { kind: 'none', chars: 0, bareGoAhead: false, gapMs: null } }) as StopRef;
    const stops = [mk('a', 'archive'), mk('t', 'transcript')];
    const labels: FinalLabelRow[] = [
      { id: 'a', label: 'needs_user', decidedBy: 'agreed', outward: true },
      { id: 't', label: 'carry_on_ok', decidedBy: 'agreed', outward: false },
    ];
    const res = (id: string, action: string, latencyMs: number): ResultRow => ({ id, parseOk: true, action, latencyMs, promptChars: 1 });
    const results = [res('a', 'needs_user', 1000), res('t', 'carry_on', 3000), res('w1', 'carry_on', 2000), res('w2', 'needs_user', 4000)];
    const written = ['w1', 'w2'].map((id) => mk(id, 'written'));
    const report = buildScoreReport(stops, labels, results, written);
    expect(report).toContain('== archive (1 items)');
    expect(report).toContain('== transcript (1 items)');
    expect(report).toContain('== written outward asks (2 items');
    expect(report).toContain('Written outward asks answered carry_on | 0 (separate) | 1/2 | 50.0%');
    expect(report).toContain('Wilson');
    expect(report).toContain('median 2000');
    expect(report).toContain('needs_user | 0 | 1 | 0 | 0');
  });
  it('labelByDecision counts each cell', () => {
    const lines = labelByDecision([item('a', 'archive', 'finished', 'carry_on'), item('b', 'archive', 'finished', 'finished')]);
    expect(lines.at(-1)).toBe('finished | 1 | 0 | 1 | 0');
  });
});
