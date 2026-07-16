/**
 * WS5 (loop-convergence plan) — pure retry-decision matrix tests.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_EVIDENCE_MAX_FILES,
  decideDegradedRetry,
  deriveAttemptEvidenceFromResult,
  unknownAttemptEvidence,
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

  it('degraded + writes-observed → pause-review naming the changed paths, never a replay', () => {
    const d = decideDegradedRetry({
      evidence: evidence({
        workspaceEffect: 'writes-observed',
        filesChanged: [change('src/a.ts'), change('src/b.ts')],
      }),
      degradedReason: 'transient-error', attemptsSoFar: 0, maxRetries: 5,
    });
    expect(d.action).toBe('pause-review');
    if (d.action === 'pause-review') {
      expect(d.reason).toContain('src/a.ts');
      expect(d.reason).toContain('src/b.ts');
      expect(d.reason).toContain('double-apply');
    }
  });

  it('writes-observed pause bounds the path list', () => {
    const files = Array.from({ length: 20 }, (_, i) => change(`src/f${i}.ts`));
    const d = decideDegradedRetry({
      evidence: evidence({ workspaceEffect: 'writes-observed', filesChanged: files }),
      degradedReason: 'void', attemptsSoFar: 0, maxRetries: 5,
    });
    expect(d.action).toBe('pause-review');
    if (d.action === 'pause-review') expect(d.reason).toContain('+12 more');
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
