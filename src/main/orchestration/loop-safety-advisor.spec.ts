import { describe, it, expect } from 'vitest';
import { critiqueLoopIteration } from './loop-safety-advisor';
import type { LoopIteration } from '../../shared/types/loop.types';

function iteration(overrides: Partial<LoopIteration>): LoopIteration {
  return {
    id: 'it-1',
    loopRunId: 'run-1',
    seq: 1,
    stage: 'execute' as LoopIteration['stage'],
    startedAt: 0,
    endedAt: 1,
    childInstanceId: null,
    tokens: 0,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: '',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'progress' as LoopIteration['progressVerdict'],
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}

describe('critiqueLoopIteration', () => {
  it('flags a destructive op in the iteration output as blocking', () => {
    const c = critiqueLoopIteration(iteration({ outputExcerpt: 'Cleaning up with rm -rf dist/' }));
    expect(c.approved).toBe(false);
    expect(c.blocking.some((o) => o.kind === 'destructive')).toBe(true);
  });

  it('flags an unbacked completion claim when no verification ran', () => {
    const c = critiqueLoopIteration(
      iteration({ outputExcerpt: 'Task complete, the feature works.', verifyStatus: 'not-run' }),
    );
    expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(true);
  });

  it('treats a passed verify as evidence (no missing-evidence objection)', () => {
    const c = critiqueLoopIteration(
      iteration({ outputExcerpt: 'All done.', verifyStatus: 'passed' }),
    );
    expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(false);
  });

  it('treats a FAILED verify as "verification ran" (no missing-evidence; the loop handles failure separately)', () => {
    const c = critiqueLoopIteration(
      iteration({ outputExcerpt: 'Done.', verifyStatus: 'failed', testFailCount: 3 }),
    );
    expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(false);
  });

  it('treats a recorded test count as evidence', () => {
    const c = critiqueLoopIteration(
      iteration({ outputExcerpt: 'Implemented.', testPassCount: 10 }),
    );
    expect(c.blocking.some((o) => o.kind === 'missing-evidence')).toBe(false);
  });

  it('approves a clean iteration', () => {
    const c = critiqueLoopIteration(iteration({ outputExcerpt: 'Investigating the parser bug.' }));
    expect(c.approved).toBe(true);
  });
});
