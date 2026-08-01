import { describe, expect, it } from 'vitest';
import { computeWorkHash, reanchorAnnotation, type AnchorLine } from './diff-annotation-anchor';
import type { DiffAnnotation } from '../../../../shared/types/diff-annotation.types';

function makeAnnotation(overrides: Partial<DiffAnnotation> = {}): DiffAnnotation {
  return {
    id: 'a1',
    path: 'src/x.ts',
    side: 'new',
    lineRange: { start: 5, end: 6 },
    excerpt: 'line-a\nline-b',
    comment: 'fix this',
    state: 'fresh',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function lines(spec: [number, string][]): AnchorLine[] {
  return spec.map(([lineNumber, text]) => ({ lineNumber, text }));
}

describe('reanchorAnnotation', () => {
  const cases: {
    name: string;
    annotation: DiffAnnotation;
    currentLines: AnchorLine[];
    expectState: DiffAnnotation['state'];
    expectRange: { start: number; end: number };
  }[] = [
    {
      name: 'exact match at the same range → fresh',
      annotation: makeAnnotation(),
      currentLines: lines([
        [4, 'unrelated'],
        [5, 'line-a'],
        [6, 'line-b'],
        [7, 'unrelated-2'],
      ]),
      expectState: 'fresh',
      expectRange: { start: 5, end: 6 },
    },
    {
      name: 'exact match shifted to a different unique range → re-anchored',
      annotation: makeAnnotation(),
      currentLines: lines([
        [1, 'inserted-above'],
        [2, 'inserted-above-2'],
        [6, 'line-a'],
        [7, 'line-b'],
      ]),
      expectState: 're-anchored',
      expectRange: { start: 6, end: 7 },
    },
    {
      name: 'no match anywhere → stale, range preserved',
      annotation: makeAnnotation(),
      currentLines: lines([
        [5, 'totally-different'],
        [6, 'also-different'],
      ]),
      expectState: 'stale',
      expectRange: { start: 5, end: 6 },
    },
    {
      name: 'excerpt occurs twice (ambiguous) → stale, range preserved',
      annotation: makeAnnotation(),
      currentLines: lines([
        [1, 'line-a'],
        [2, 'line-b'],
        [10, 'line-a'],
        [11, 'line-b'],
      ]),
      expectState: 'stale',
      expectRange: { start: 5, end: 6 },
    },
    {
      name: 'single-line excerpt matches uniquely at a new line',
      annotation: makeAnnotation({ lineRange: { start: 3, end: 3 }, excerpt: 'solo-line' }),
      currentLines: lines([
        [1, 'noise'],
        [9, 'solo-line'],
      ]),
      expectState: 're-anchored',
      expectRange: { start: 9, end: 9 },
    },
    {
      name: 'empty currentLines → stale',
      annotation: makeAnnotation(),
      currentLines: [],
      expectState: 'stale',
      expectRange: { start: 5, end: 6 },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = reanchorAnnotation(c.annotation, c.currentLines);
      expect(result.state).toBe(c.expectState);
      expect(result.lineRange).toEqual(c.expectRange);
      // Original excerpt/comment are never rewritten by reconciliation.
      expect(result.excerpt).toBe(c.annotation.excerpt);
      expect(result.comment).toBe(c.annotation.comment);
    });
  }

  it('returns the same object reference when re-verifying an already-fresh annotation with no change', () => {
    const annotation = makeAnnotation();
    const current = lines([
      [5, 'line-a'],
      [6, 'line-b'],
    ]);
    const result = reanchorAnnotation(annotation, current);
    expect(result).toBe(annotation);
  });

  it('returns the same object reference when re-verifying an already-stale annotation with no new match', () => {
    const annotation = makeAnnotation({ state: 'stale' });
    const current = lines([[1, 'still-nothing']]);
    const result = reanchorAnnotation(annotation, current);
    expect(result).toBe(annotation);
  });
});

describe('computeWorkHash', () => {
  it('is deterministic for the same lines', () => {
    const input = lines([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(computeWorkHash(input)).toBe(computeWorkHash(input));
  });

  it('differs when line content differs', () => {
    const a = computeWorkHash(lines([[1, 'a']]));
    const b = computeWorkHash(lines([[1, 'b']]));
    expect(a).not.toBe(b);
  });

  it('returns a stable-length hex string for empty input', () => {
    expect(computeWorkHash([])).toMatch(/^[0-9a-f]{8}$/);
  });
});
