/**
 * LF-2 (loopfixex.md) — semantic-progress escalation modifier.
 *
 * The reviewer is an escalation MODIFIER, never a sole stop/continue authority:
 * it can upgrade a structural WARN to CRITICAL on confirmed no-progress, or
 * soften a churn-only CRITICAL to WARN on confirmed progress — and only after
 * two consecutive confident checks agree.
 */

import { describe, expect, it } from 'vitest';
import type { LoopSemanticProgressResult, ProgressSignalEvidence } from '../../shared/types/loop.types';
import {
  NEUTRAL_SEMANTIC_RESULT,
  findPreviousSemanticResult,
  parseSemanticResult,
  reconcileSemanticVerdict,
  shouldRunSemanticCheck,
  withSemanticTimeout,
} from './loop-semantic-progress';

function sig(id: ProgressSignalEvidence['id'], verdict: ProgressSignalEvidence['verdict']): ProgressSignalEvidence {
  return { id, verdict, message: `${id}/${verdict}` };
}
function result(advanced: boolean, confidence: number): LoopSemanticProgressResult {
  return { advanced, whatChanged: advanced ? 'moved forward' : 'no real change', confidence };
}

describe('shouldRunSemanticCheck', () => {
  it('never runs when disabled', () => {
    expect(shouldRunSemanticCheck({ enabled: false, structuralVerdict: 'CRITICAL', seq: 5, cadence: 5 })).toBe(false);
  });
  it('always runs when there is a structural concern', () => {
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'WARN', seq: 1, cadence: 5 })).toBe(true);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'CRITICAL', seq: 2, cadence: 5 })).toBe(true);
  });
  it('runs on the cadence cycle while OK, otherwise skips', () => {
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 5, cadence: 5 })).toBe(true);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 6, cadence: 5 })).toBe(false);
    expect(shouldRunSemanticCheck({ enabled: true, structuralVerdict: 'OK', seq: 0, cadence: 5 })).toBe(false);
  });
});

describe('reconcileSemanticVerdict', () => {
  const floor = 0.6;

  it('leaves the verdict unchanged below the confidence floor', () => {
    const r = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: result(false, 0.4),
      previous: result(false, 0.9),
      confidenceFloor: floor,
    });
    expect(r.changed).toBe(false);
    expect(r.verdict).toBe('WARN');
  });

  it('requires a confirming second consecutive check before flipping', () => {
    const r = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: result(false, 0.9),
      previous: null, // no prior check
      confidenceFloor: floor,
    });
    expect(r.changed).toBe(false);
  });

  it('upgrades WARN → CRITICAL on two confident no-progress checks', () => {
    const r = reconcileSemanticVerdict({
      structuralVerdict: 'WARN',
      structuralSignals: [sig('A', 'WARN')],
      current: result(false, 0.8),
      previous: result(false, 0.7),
      confidenceFloor: floor,
    });
    expect(r.changed).toBe(true);
    expect(r.verdict).toBe('CRITICAL');
  });

  it('softens a churn-only CRITICAL → WARN on confirmed progress', () => {
    const r = reconcileSemanticVerdict({
      structuralVerdict: 'CRITICAL',
      structuralSignals: [sig('A', 'CRITICAL'), sig('H', 'CRITICAL')],
      current: result(true, 0.9),
      previous: result(true, 0.8),
      confidenceFloor: floor,
    });
    expect(r.changed).toBe(true);
    expect(r.verdict).toBe('WARN');
  });

  it('does NOT soften a CRITICAL that includes non-churn structural signals', () => {
    const r = reconcileSemanticVerdict({
      structuralVerdict: 'CRITICAL',
      structuralSignals: [sig('A', 'CRITICAL'), sig('D-prime', 'CRITICAL')],
      current: result(true, 0.9),
      previous: result(true, 0.9),
      confidenceFloor: floor,
    });
    expect(r.changed).toBe(false);
    expect(r.verdict).toBe('CRITICAL');
  });
});

describe('parseSemanticResult', () => {
  it('parses a clean JSON object', () => {
    expect(parseSemanticResult('{"advanced": false, "whatChanged": "stuck", "confidence": 0.8}'))
      .toEqual({ advanced: false, whatChanged: 'stuck', confidence: 0.8 });
  });
  it('tolerates surrounding prose and clamps confidence', () => {
    const r = parseSemanticResult('Sure!\n{"advanced": true, "whatChanged": "x", "confidence": 1.7} done');
    expect(r.advanced).toBe(true);
    expect(r.confidence).toBe(1);
  });
  it('degrades to neutral on malformed input', () => {
    expect(parseSemanticResult('not json')).toEqual(NEUTRAL_SEMANTIC_RESULT);
  });
});

describe('withSemanticTimeout', () => {
  it('resolves the operation when it settles in time', async () => {
    await expect(withSemanticTimeout(Promise.resolve(result(false, 0.9)), 1000))
      .resolves.toEqual(result(false, 0.9));
  });
  it('yields the neutral result on a rejected operation', async () => {
    await expect(withSemanticTimeout(Promise.reject(new Error('boom')), 1000))
      .resolves.toEqual(NEUTRAL_SEMANTIC_RESULT);
  });
  it('yields the neutral result on timeout', async () => {
    const never = new Promise<LoopSemanticProgressResult>(() => { /* never settles */ });
    await expect(withSemanticTimeout(never, 10)).resolves.toEqual(NEUTRAL_SEMANTIC_RESULT);
  });
});

describe('findPreviousSemanticResult', () => {
  it('returns the most recent prior semantic verdict, newest-first', () => {
    const history = [
      { semanticProgress: result(true, 0.5) },
      { semanticProgress: result(false, 0.9) },
      {}, // iteration with no semantic check
    ];
    expect(findPreviousSemanticResult(history)).toEqual(result(false, 0.9));
  });
  it('returns null when no prior semantic verdict exists', () => {
    expect(findPreviousSemanticResult([{}, {}])).toBeNull();
  });
});
