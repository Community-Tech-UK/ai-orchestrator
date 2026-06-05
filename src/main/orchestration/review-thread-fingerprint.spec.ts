import { describe, it, expect } from 'vitest';
import {
  fingerprintReviewThread,
  computeReviewThreadSet,
  dedupeAndRankFindings,
  diffReviewThreads,
  computeCompletionEvidenceHash,
  pushBoundedEvidence,
  DEFAULT_EVIDENCE_BUFFER_LEN,
} from './review-thread-fingerprint';

interface TestFinding {
  title: string;
  body: string;
  severity: string;
  file?: string;
  confidence?: number;
}

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

describe('dedupeAndRankFindings', () => {
  it('collapses duplicate findings that two reviewers raised for the same issue', () => {
    const findings: TestFinding[] = [
      { title: 'Plan claims X but code shows Y', body: 'gemini wording', severity: 'critical', file: 'src/a.ts', confidence: 0.8 },
      { title: 'Plan claims X but code shows Y.', body: 'codex wording', severity: 'critical', file: 'src/a.ts', confidence: 0.95 },
    ];
    const ranked = dedupeAndRankFindings(findings);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].corroborations).toBe(2);
    // The higher-confidence representative is kept.
    expect(ranked[0].finding.body).toBe('codex wording');
  });

  it('orders survivors by severity (critical → low), then by descending confidence', () => {
    const findings: TestFinding[] = [
      { title: 'low thing', body: '', severity: 'low', confidence: 0.9 },
      { title: 'crit thing', body: '', severity: 'critical', confidence: 0.5 },
      { title: 'high A', body: '', severity: 'high', confidence: 0.6 },
      { title: 'high B', body: '', severity: 'high', confidence: 0.9 },
    ];
    const ranked = dedupeAndRankFindings(findings);
    expect(ranked.map((r) => r.finding.title)).toEqual([
      'crit thing',
      'high B', // higher confidence sorts before high A within 'high'
      'high A',
      'low thing',
    ]);
  });

  it('keeps findings with the same title but different severity as distinct threads', () => {
    const findings: TestFinding[] = [
      { title: 'same title', body: '', severity: 'critical', file: 'f.ts' },
      { title: 'same title', body: '', severity: 'high', file: 'f.ts' },
    ];
    const ranked = dedupeAndRankFindings(findings);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.corroborations === 1)).toBe(true);
  });

  it('is deterministic regardless of input order', () => {
    const a: TestFinding[] = [
      { title: 'b', body: '', severity: 'high', confidence: 0.5 },
      { title: 'a', body: '', severity: 'high', confidence: 0.5 },
    ];
    const b = [...a].reverse();
    expect(dedupeAndRankFindings(a).map((r) => r.threadId)).toEqual(
      dedupeAndRankFindings(b).map((r) => r.threadId),
    );
  });

  it('returns an empty array for no findings', () => {
    expect(dedupeAndRankFindings([])).toEqual([]);
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
