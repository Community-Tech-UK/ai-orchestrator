/**
 * WS5 (loop-convergence plan) — pure retry-decision matrix tests.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_EVIDENCE_MAX_FILES,
  decideDegradedRetry,
  deriveAttemptEvidenceFromResult,
  unknownAttemptEvidence,
  unreplayableAttemptResult,
  type LoopInvocationAttemptEvidence,
} from './loop-invocation-attempt';

function evidence(over: Partial<LoopInvocationAttemptEvidence> = {}): LoopInvocationAttemptEvidence {
  return {
    outcome: 'failed',
    outputExcerpt: 'boom',
    workspaceEffect: 'none-observed',
    filesChanged: [],
    providerThreadReusable: false,
    ...over,
  };
}

const change = (path: string) => ({ path, additions: 1, deletions: 0, contentHash: `h-${path}` });

describe('decideDegradedRetry — retry matrix', () => {
  it('healthy attempt (no degraded reason) proceeds', () => {
    expect(decideDegradedRetry({
      evidence: evidence({ outcome: 'completed' }), degradedReason: null, attemptsSoFar: 0, maxRetries: 2,
    })).toEqual({ action: 'proceed' });
  });

  it('degraded + none-observed + budget left → bounded retry (fresh session by default)', () => {
    const d = decideDegradedRetry({
      evidence: evidence(), degradedReason: 'void', attemptsSoFar: 0, maxRetries: 2,
    });
    expect(d.action).toBe('retry');
    if (d.action === 'retry') {
      expect(d.preserveThread).toBe(false);
      expect(d.note).toContain('no workspace writes observed');
    }
  });

  it('degraded + none-observed + reusable native thread → retry preserving the thread', () => {
    const d = decideDegradedRetry({
      evidence: evidence({ providerThreadReusable: true }),
      degradedReason: 'transient-error', attemptsSoFar: 1, maxRetries: 2,
    });
    expect(d.action).toBe('retry');
    if (d.action === 'retry') expect(d.preserveThread).toBe(true);
  });

  it('degraded + none-observed + budget exhausted → proceed (existing error/normal path)', () => {
    expect(decideDegradedRetry({
      evidence: evidence(), degradedReason: 'void', attemptsSoFar: 2, maxRetries: 2,
    })).toEqual({ action: 'proceed' });
  });

  it('degraded + writes-observed → continue WITHOUT replay, naming the changed paths', () => {
    const d = decideDegradedRetry({
      evidence: evidence({
        workspaceEffect: 'writes-observed',
        filesChanged: [change('src/a.ts'), change('src/b.ts')],
      }),
      degradedReason: 'transient-error', attemptsSoFar: 0, maxRetries: 5,
    });
    // Never a replay (the WS5 invariant) — but the run is NOT ended either: the
    // delta is a whole-workspace diff and may belong to a concurrent writer.
    expect(d.action).toBe('continue-without-replay');
    if (d.action === 'continue-without-replay') {
      expect(d.reason).toContain('src/a.ts');
      expect(d.reason).toContain('src/b.ts');
      expect(d.reason).toContain('double-apply');
      expect(d.reason).toContain('another writer');
    }
  });

  it('writes-observed bounds the path list', () => {
    const files = Array.from({ length: 20 }, (_, i) => change(`src/f${i}.ts`));
    const d = decideDegradedRetry({
      evidence: evidence({ workspaceEffect: 'writes-observed', filesChanged: files }),
      degradedReason: 'void', attemptsSoFar: 0, maxRetries: 5,
    });
    expect(d.action).toBe('continue-without-replay');
    if (d.action === 'continue-without-replay') expect(d.reason).toContain('+12 more');
  });

  it('a one-off writes-observed failure does not end the run, but a repeated one still can', () => {
    // Regression guard for the real failure: the decision must not depend on
    // how dirty the tree looks, because the loop cannot attribute the dirt.
    const noisy = evidence({
      workspaceEffect: 'writes-observed',
      filesChanged: [change('grok.md'), change('fable_todo2.md')],
    });
    for (const attemptsSoFar of [0, 1, 4]) {
      expect(decideDegradedRetry({
        evidence: noisy, degradedReason: 'invocation-error', attemptsSoFar, maxRetries: 5,
      }).action).toBe('continue-without-replay');
    }
  });

  it('degraded + unknown workspace state → pause-review with the observer note', () => {
    const d = decideDegradedRetry({
      evidence: evidence({ workspaceEffect: 'unknown', reason: 'git snapshot failed: ENOENT' }),
      degradedReason: 'transient-error', attemptsSoFar: 0, maxRetries: 5,
    });
    expect(d.action).toBe('pause-review');
    if (d.action === 'pause-review') {
      expect(d.reason).toContain('UNPROVABLE');
      expect(d.reason).toContain('git snapshot failed: ENOENT');
    }
  });
});

describe('deriveAttemptEvidenceFromResult', () => {
  it('a returned result with no file changes is a completed, none-observed attempt', () => {
    const e = deriveAttemptEvidenceFromResult({ output: 'ok', filesChanged: [] });
    expect(e).toMatchObject({ outcome: 'completed', workspaceEffect: 'none-observed' });
  });

  it('a returned degraded result with writes is degraded + writes-observed', () => {
    const e = deriveAttemptEvidenceFromResult({
      output: 'partial', filesChanged: [change('x.ts')], degradedReason: 'stream-cut',
    });
    expect(e).toMatchObject({ outcome: 'degraded', workspaceEffect: 'writes-observed', reason: 'stream-cut' });
  });

  it('bounds the copied file list and output excerpt (101 emitted bytes prove nothing)', () => {
    const files = Array.from({ length: ATTEMPT_EVIDENCE_MAX_FILES + 10 }, (_, i) => change(`f${i}`));
    const e = deriveAttemptEvidenceFromResult({ output: 'x'.repeat(10_000), filesChanged: files });
    expect(e.filesChanged).toHaveLength(ATTEMPT_EVIDENCE_MAX_FILES);
    expect(e.outputExcerpt.length).toBeLessThanOrEqual(500);
    // Output presence NEVER flips the workspace effect.
    expect(e.workspaceEffect).toBe('writes-observed');
  });
});

describe('unknownAttemptEvidence', () => {
  it('is failed + unknown and never claims none-observed', () => {
    const e = unknownAttemptEvidence('Loop iteration timed out after 60000ms');
    expect(e.outcome).toBe('failed');
    expect(e.workspaceEffect).toBe('unknown');
    expect(e.reason).toContain('timed out');
  });
});

describe('unreplayableAttemptResult', () => {
  const observed = {
    outcome: 'failed' as const,
    outputExcerpt: 'boom',
    workspaceEffect: 'writes-observed' as const,
    filesChanged: [change('src/a.ts'), change('grok.md')],
    providerThreadReusable: false,
  };

  it('claims NO files changed, so unattributable writes cannot fake progress', () => {
    // Crediting these paths would reset the review-driven stall counter
    // (`madeProductionChange`) and mask a genuinely stuck loop.
    const r = unreplayableAttemptResult(observed, 'ECONNRESET', 'not replayed');
    expect(r.filesChanged).toEqual([]);
    expect(r.toolCalls).toEqual([]);
    expect(r.tokens).toBe(0);
    expect(r.exitedCleanly).toBe(false);
  });

  it('reports the observed paths and the reason in the output for the human', () => {
    const r = unreplayableAttemptResult(observed, 'ECONNRESET', 'workspace writes observed');
    expect(r.output).toContain('workspace writes observed');
    expect(r.output).toContain('src/a.ts');
    expect(r.output).toContain('grok.md');
    expect(r.output).toContain('ECONNRESET');
  });

  it('keeps the invocation error as a stable bucket so signal E can escalate repeats', () => {
    const a = unreplayableAttemptResult(observed, 'ECONNRESET', 'r');
    const b = unreplayableAttemptResult(observed, 'ECONNRESET', 'r');
    const other = unreplayableAttemptResult(observed, 'ETIMEDOUT', 'r');
    expect(a.errors[0]?.bucket).toBe('provider-invocation-error');
    // Identical errors hash identically — that is what lets E count repeats.
    expect(a.errors[0]?.exactHash).toBe(b.errors[0]?.exactHash);
    expect(a.errors[0]?.exactHash).not.toBe(other.errors[0]?.exactHash);
  });

  it('records no error when there was no invocation error', () => {
    expect(unreplayableAttemptResult(observed, null, 'r').errors).toEqual([]);
  });
});
