import { describe, it, expect } from 'vitest';
import {
  fingerprintReviewThread,
  computeReviewThreadSet,
  diffReviewThreads,
  computeCompletionEvidenceHash,
  pushBoundedEvidence,
  DEFAULT_EVIDENCE_BUFFER_LEN,
} from './review-thread-fingerprint';

describe('fingerprintReviewThread', () => {
  it('is stable across minor body rewording (title+severity+file drive the id)', () => {
    const a = fingerprintReviewThread({ title: 'Null deref in parser', severity: 'high', file: 'src/p.ts' });
    const b = fingerprintReviewThread({ title: 'Null deref in parser', severity: 'high', file: 'src/p.ts' });
    expect(a).toBe(b);
  });

  it('normalizes whitespace, case, and punctuation in the title', () => {
    const a = fingerprintReviewThread({ title: 'Null   deref in PARSER.', severity: 'high', file: 'src/p.ts' });
    const b = fingerprintReviewThread({ title: 'null deref in parser', severity: 'high', file: 'src/p.ts' });
    expect(a).toBe(b);
  });

  it('differs when severity differs', () => {
    const a = fingerprintReviewThread({ title: 'X', severity: 'high', file: 'f' });
    const b = fingerprintReviewThread({ title: 'X', severity: 'critical', file: 'f' });
    expect(a).not.toBe(b);
  });

  it('differs when file differs (same title)', () => {
    const a = fingerprintReviewThread({ title: 'X', severity: 'high', file: 'a.ts' });
    const b = fingerprintReviewThread({ title: 'X', severity: 'high', file: 'b.ts' });
    expect(a).not.toBe(b);
  });

  it('treats missing file consistently', () => {
    const a = fingerprintReviewThread({ title: 'X', severity: 'high' });
    const b = fingerprintReviewThread({ title: 'X', severity: 'high', file: '' });
    expect(a).toBe(b);
  });
});

describe('computeReviewThreadSet', () => {
  it('de-duplicates and sorts', () => {
    const set = computeReviewThreadSet([
      { title: 'A', severity: 'high' },
      { title: 'A', severity: 'high' },
      { title: 'B', severity: 'high' },
    ]);
    expect(set).toHaveLength(2);
    expect([...set]).toEqual([...set].sort());
  });

  it('is order-independent', () => {
    const s1 = computeReviewThreadSet([{ title: 'A', severity: 'high' }, { title: 'B', severity: 'low' }]);
    const s2 = computeReviewThreadSet([{ title: 'B', severity: 'low' }, { title: 'A', severity: 'high' }]);
    expect(s1).toEqual(s2);
  });
});

describe('diffReviewThreads', () => {
  it('classifies persisted / resolved / added', () => {
    const prev = ['a', 'b', 'c'];
    const curr = ['b', 'c', 'd'];
    const diff = diffReviewThreads(prev, curr);
    expect(diff.persisted).toEqual(['b', 'c']);
    expect(diff.resolved).toEqual(['a']);
    expect(diff.added).toEqual(['d']);
  });

  it('reports everything resolved when curr is empty (the convergence condition)', () => {
    const diff = diffReviewThreads(['a', 'b'], []);
    expect(diff.persisted).toEqual([]);
    expect(diff.resolved).toEqual(['a', 'b']);
    expect(diff.added).toEqual([]);
  });

  it('reports all added on first round (no prior threads)', () => {
    const diff = diffReviewThreads([], ['x', 'y']);
    expect(diff.added).toEqual(['x', 'y']);
    expect(diff.persisted).toEqual([]);
  });
});

describe('computeCompletionEvidenceHash', () => {
  const base = {
    candidateId: 'declared-complete',
    verifyStatus: 'passed',
    beltAndBracesPassed: true,
    unresolvedReviewThreads: ['t1', 't2'],
  };

  it('is identical for identical evidence', () => {
    expect(computeCompletionEvidenceHash(base)).toBe(computeCompletionEvidenceHash({ ...base }));
  });

  it('is order-independent in the unresolved-thread set', () => {
    expect(computeCompletionEvidenceHash(base)).toBe(
      computeCompletionEvidenceHash({ ...base, unresolvedReviewThreads: ['t2', 't1'] }),
    );
  });

  it('changes when verify status changes', () => {
    expect(computeCompletionEvidenceHash(base)).not.toBe(
      computeCompletionEvidenceHash({ ...base, verifyStatus: 'failed' }),
    );
  });

  it('changes when the unresolved-thread set changes (issue resolved/added)', () => {
    expect(computeCompletionEvidenceHash(base)).not.toBe(
      computeCompletionEvidenceHash({ ...base, unresolvedReviewThreads: ['t1'] }),
    );
  });

  it('changes when belt-and-braces flips', () => {
    expect(computeCompletionEvidenceHash(base)).not.toBe(
      computeCompletionEvidenceHash({ ...base, beltAndBracesPassed: false }),
    );
  });
});

describe('pushBoundedEvidence', () => {
  it('reports repeatCount 1 on first push', () => {
    const r = pushBoundedEvidence(undefined, 'h1');
    expect(r.buffer).toEqual(['h1']);
    expect(r.repeatCount).toBe(1);
  });

  it('increments repeatCount while unchanged evidence repeats', () => {
    let r = pushBoundedEvidence(undefined, 'h1');
    r = pushBoundedEvidence(r.buffer, 'h1');
    expect(r.repeatCount).toBe(2);
    r = pushBoundedEvidence(r.buffer, 'h1');
    expect(r.repeatCount).toBe(3);
  });

  it('resets repeatCount to 1 the moment evidence changes (genuine new evidence)', () => {
    let r = pushBoundedEvidence(undefined, 'h1');
    r = pushBoundedEvidence(r.buffer, 'h1');
    expect(r.repeatCount).toBe(2);
    r = pushBoundedEvidence(r.buffer, 'h2');
    expect(r.repeatCount).toBe(1);
  });

  it('bounds the buffer to maxLen, keeping the most recent', () => {
    let buf: string[] | undefined;
    for (let i = 0; i < DEFAULT_EVIDENCE_BUFFER_LEN + 3; i++) {
      buf = pushBoundedEvidence(buf, `h${i}`).buffer;
    }
    expect(buf!).toHaveLength(DEFAULT_EVIDENCE_BUFFER_LEN);
    expect(buf![buf!.length - 1]).toBe(`h${DEFAULT_EVIDENCE_BUFFER_LEN + 2}`);
  });

  it('respects a custom maxLen', () => {
    let r = pushBoundedEvidence(undefined, 'a', 2);
    r = pushBoundedEvidence(r.buffer, 'b', 2);
    r = pushBoundedEvidence(r.buffer, 'c', 2);
    expect(r.buffer).toEqual(['b', 'c']);
  });
});
