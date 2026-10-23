import { describe, expect, it } from 'vitest';
import { toHeadlessFindings } from './headless-review-findings';
import { EVIDENCE_TAIL_MARKER } from './review-prompts';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import { isBlockingFreshEyesFinding } from './loop-fresh-eyes-reviewer';

function baseReview(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    reviewerId: 'codex',
    reviewType: 'structured',
    scores: {
      correctness: { reasoning: 'ok', score: 4, issues: [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: 'APPROVE',
    summary: 'fine',
    timestamp: 0,
    durationMs: 0,
    parseSuccess: true,
    ...over,
  };
}

describe('toHeadlessFindings (WS-A3 evidence extraction)', () => {
  it.each([1, 3])('keeps screen notes advisory at score %s, with evidence preserved', (score) => {
    const review = baseReview();
    review.scores.consistency = { reasoning: 'screen', score: score as 1 | 3,
      issues: [`UI: missing tooltip\n${EVIDENCE_TAIL_MARKER}\n{"file":"src/renderer/app/app.component.html","lines":[1,1],"quote":"<button>×</button>"}`] };
    const [finding] = toHeadlessFindings(review);
    expect(finding).toMatchObject({ title: 'codex screen and wording note', body: 'missing tooltip', severity: 'low', advisory: true });
    expect(finding.anchor?.quote).toBe('<button>×</button>');
    expect(isBlockingFreshEyesFinding(finding, ['critical', 'high', 'medium', 'low'])).toBe(false);
  });

  it('keeps critical_issues screen notes advisory', () => {
    const [finding] = toHeadlessFindings(baseReview({ criticalIssues: ['UI: missing accessible name'] }));
    expect(finding).toMatchObject({ severity: 'low', advisory: true, body: 'missing accessible name' });
    expect(isBlockingFreshEyesFinding(finding, ['critical', 'high', 'medium', 'low'])).toBe(false);
  });
  it('parses an evidence tail on a critical issue into an anchor and marks it localized', () => {
    const review = baseReview({
      criticalIssues: [
        `Auth bypass on the admin route.\n${EVIDENCE_TAIL_MARKER}\n` +
          `{"file": "src/admin.ts", "lines": [10, 12], "quote": "if (true) return next();"}`,
      ],
    });

    const [finding] = toHeadlessFindings(review);
    expect(finding.body).toBe('Auth bypass on the admin route.');
    expect(finding.anchor).toEqual({
      quote: 'if (true) return next();',
      file: 'src/admin.ts',
      lineRange: [10, 12],
    });
    expect(finding.evidenceClass).toBe('localized');
  });

  it('marks a dimension issue with no evidence tail as unlocalized-advisory', () => {
    const review = baseReview({
      scores: {
        correctness: { reasoning: 'bad', score: 1, issues: ['Off-by-one in the loop bound.'] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
    });

    const [finding] = toHeadlessFindings(review);
    expect(finding.body).toBe('Off-by-one in the loop bound.');
    expect(finding.anchor).toBeUndefined();
    expect(finding.evidenceClass).toBe('unlocalized-advisory');
  });

  it('marks the whole-review fallback verdict finding as unlocalized-advisory', () => {
    const review = baseReview({ overallVerdict: 'REJECT', summary: 'Rejected overall.' });
    const [finding] = toHeadlessFindings(review);
    expect(finding.evidenceClass).toBe('unlocalized-advisory');
    expect(finding.anchor).toBeUndefined();
  });
});
