import { describe, it, expect } from 'vitest';
import {
  shouldRunSemanticCheck,
  reconcileSemanticVerdict,
  parseSemanticResult,
  findPreviousSemanticResult,
  withSemanticTimeout,
  NEUTRAL_SEMANTIC_RESULT,
  CHURN_SIGNAL_IDS,
} from '../loop-semantic-progress';
import type {
  LoopSemanticProgressResult,
  LoopVerdict,
  ProgressSignalEvidence,
  ProgressSignalId,
} from '../../../shared/types/loop.types';

const sig = (id: ProgressSignalId, verdict: LoopVerdict): ProgressSignalEvidence => ({
  id,
  verdict,
  message: `${id}/${verdict}`,
});
const res = (advanced: boolean, confidence: number): LoopSemanticProgressResult => ({
  advanced,
  whatChanged: advanced ? 'made progress' : 'no progress',
  confidence,
});

describe('shouldRunSemanticCheck', () => {
  it('never runs when disabled, regardless of verdict/seq', () => {
    expect(shouldRunSemanticCheck({ enabled: false, structuralVerdict: 'CRITICAL', seq: 5, cadence: 5 })).toBe(false);
    expect(shouldRunSemanticCheck({ enabled: false, structuralVerdict: 'WARN', seq: 3, cadence: 5 })).toBe(false);
  });

  it('runs on any structural concern (WARN/CRITICAL) when enabled', () => {
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'WARN', seq: 1, cadence: 5 })).toBe(true);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'CRITICAL', seq: 2, cadence: 5 })).toBe(true);
  });

  it('runs periodically on OK only at the cadence boundary (seq>0)', () => {
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 5, cadence: 5 })).toBe(true);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 10, cadence: 5 })).toBe(true);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 4, cadence: 5 })).toBe(false);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 0, cadence: 5 })).toBe(false);
  });

  it('disables the periodic check when cadence is 0', () => {
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 10, cadence: 0 })).toBe(false);
  });
});

describe('reconcileSemanticVerdict', () => {
  const floor = 0.6;

  it('leaves the verdict unchanged when confidence is below the floor', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: res(false, 0.5), // below floor
      previous: res(false, 0.9),
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('WARN');
  });

  it('requires a confirming previous check before flipping (no flip on first confident check)', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: res(false, 0.9),
      previous: null,
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('WARN');
  });

  it('UPGRADES WARN→CRITICAL on two consecutive confident "did not advance"', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: res(false, 0.85),
      previous: res(false, 0.7),
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(true);
    expect(out.verdict).toBe('CRITICAL');
  });

  it('does NOT upgrade when the previous check disagrees', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: res(false, 0.9),
      previous: res(true, 0.9), // disagrees
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('WARN');
  });

  it('SOFTENS a churn-only CRITICAL→WARN on confirmed "did advance"', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'CRITICAL',
      structuralSignals: [sig('A', 'CRITICAL'), sig('B', 'CRITICAL'), sig('H', 'WARN')],
      current: res(true, 0.8),
      previous: res(true, 0.7),
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(true);
    expect(out.verdict).toBe('WARN');
  });

  it('does NOT soften a CRITICAL that includes a non-churn (structural) signal', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'CRITICAL',
      structuralSignals: [sig('A', 'CRITICAL'), sig('D-prime', 'CRITICAL')], // D-prime is structural
      current: res(true, 0.95),
      previous: res(true, 0.95),
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('CRITICAL');
  });

  it('does NOT soften a churn-only CRITICAL without a confirming previous check', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'CRITICAL',
      structuralSignals: [sig('A', 'CRITICAL')],
      current: res(true, 0.95),
      previous: null,
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('CRITICAL');
  });

  it('does not change an aligned verdict (WARN + advancing, confirmed)', () => {
    const out = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: res(true, 0.9),
      previous: res(true, 0.9),
      confidenceFloor: floor,
    });
    expect(out.changed).toBe(false);
    expect(out.verdict).toBe('WARN');
  });

  it('only A/B/H are treated as churn-based signals', () => {
    expect([...CHURN_SIGNAL_IDS].sort()).toEqual(['A', 'B', 'H']);
  });
});

describe('parseSemanticResult', () => {
  it('parses a clean JSON object', () => {
    const out = parseSemanticResult('{"advanced": false, "whatChanged": "stuck on same edit", "confidence": 0.8}');
    expect(out.advanced).toBe(false);
    expect(out.confidence).toBe(0.8);
    expect(out.whatChanged).toBe('stuck on same edit');
  });

  it('extracts JSON embedded in surrounding prose', () => {
    const out = parseSemanticResult('Sure! Here is my verdict:\n{"advanced": true, "confidence": 0.7}\nHope that helps.');
    expect(out.advanced).toBe(true);
    expect(out.confidence).toBe(0.7);
  });

  it('clamps out-of-range confidence to [0,1]', () => {
    expect(parseSemanticResult('{"advanced": true, "confidence": 5}').confidence).toBe(1);
    expect(parseSemanticResult('{"advanced": true, "confidence": -2}').confidence).toBe(0);
  });

  it('degrades to neutral on malformed input', () => {
    expect(parseSemanticResult('not json at all')).toEqual(NEUTRAL_SEMANTIC_RESULT);
    expect(parseSemanticResult('{broken')).toEqual(NEUTRAL_SEMANTIC_RESULT);
  });

  it('defaults missing fields safely (advanced=true, confidence=0 ⇒ ignored by escalation)', () => {
    const out = parseSemanticResult('{"whatChanged": "unclear"}');
    expect(out.advanced).toBe(true);
    expect(out.confidence).toBe(0);
  });
});

describe('withSemanticTimeout', () => {
  it('resolves the operation value when it settles in time', async () => {
    const r = res(false, 0.9);
    await expect(withSemanticTimeout(Promise.resolve(r), 1000)).resolves.toBe(r);
  });

  it('yields the neutral result when the operation hangs past the timeout', async () => {
    const hung = new Promise<LoopSemanticProgressResult>(() => {
      /* never settles */
    });
    await expect(withSemanticTimeout(hung, 20)).resolves.toEqual(NEUTRAL_SEMANTIC_RESULT);
  });

  it('yields the neutral result when the operation rejects', async () => {
    const rejected = Promise.reject(new Error('boom')) as Promise<LoopSemanticProgressResult>;
    await expect(withSemanticTimeout(rejected, 1000)).resolves.toEqual(NEUTRAL_SEMANTIC_RESULT);
  });
});

describe('findPreviousSemanticResult', () => {
  it('returns null for empty history', () => {
    expect(findPreviousSemanticResult([])).toBeNull();
  });

  it('returns null when no iteration carries a semantic result', () => {
    expect(findPreviousSemanticResult([{}, {}, {}])).toBeNull();
  });

  it('returns the most recent semantic result (newest first)', () => {
    const older = res(true, 0.7);
    const newer = res(false, 0.9);
    const history = [{ semanticProgress: older }, {}, { semanticProgress: newer }, {}];
    expect(findPreviousSemanticResult(history)).toBe(newer);
  });
});
