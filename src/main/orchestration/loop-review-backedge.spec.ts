import { describe, expect, it } from 'vitest';
import {
  buildReviewBackEdgeIntervention,
  decideReviewBackEdge,
  REVIEW_VETO_CONFIDENCE_FLOOR,
  type ReviewBackEdgeInput,
} from './loop-review-backedge';

function input(overrides: Partial<ReviewBackEdgeInput> = {}): ReviewBackEdgeInput {
  return {
    stageBefore: 'REVIEW',
    stageAfter: 'REVIEW',
    cleanReview: { clean: true, confidence: 1, reason: 'all clear' },
    freshEyes: null,
    reviewCycles: 0,
    maxReviewCycles: 10,
    goalIntent: 'implementation',
    ...overrides,
  };
}

describe('decideReviewBackEdge', () => {
  it('does nothing when the review is clean and no gate blocked', () => {
    const decision = decideReviewBackEdge(input());
    expect(decision.action).toBe('none');
    expect(decision.fields).toEqual({
      clean: true,
      recommendation: 'APPROVE',
      architecturalStatus: 'CLEAR',
    });
  });

  it('only applies to REVIEW iterations', () => {
    const decision = decideReviewBackEdge(
      input({ stageBefore: 'IMPLEMENT', cleanReview: { clean: false, confidence: 1, reason: 'bugs' } }),
    );
    expect(decision.action).toBe('none');
  });

  it('never forces the stage for investigation loops', () => {
    const decision = decideReviewBackEdge(
      input({ goalIntent: 'investigation', cleanReview: { clean: false, confidence: 1, reason: 'more to audit' } }),
    );
    expect(decision.action).toBe('none');
  });

  it('is disabled when maxReviewCycles is 0', () => {
    const decision = decideReviewBackEdge(
      input({ maxReviewCycles: 0, cleanReview: { clean: false, confidence: 1, reason: 'bugs' } }),
    );
    expect(decision.action).toBe('none');
  });

  it('rewinds on a confident not-clean review (clean field veto)', () => {
    const decision = decideReviewBackEdge(
      input({ cleanReview: { clean: false, confidence: 0.9, reason: 'found unresolved work' } }),
    );
    expect(decision.action).toBe('rewind');
    expect(decision.fields.clean).toBe(false);
    expect(decision.needsStageWrite).toBe(true);
    expect(decision.reason).toContain('found unresolved work');
  });

  it('ignores a low-confidence not-clean classification', () => {
    const decision = decideReviewBackEdge(
      input({ cleanReview: { clean: false, confidence: REVIEW_VETO_CONFIDENCE_FLOOR - 0.1, reason: 'unclear' } }),
    );
    expect(decision.action).toBe('none');
    expect(decision.fields.clean).toBe(true);
  });

  it('rewinds when the fresh-eyes gate blocked (recommendation veto)', () => {
    const decision = decideReviewBackEdge(
      input({ freshEyes: { ran: true, blocked: true, blockingSeverities: ['high'] } }),
    );
    expect(decision.action).toBe('rewind');
    expect(decision.fields.recommendation).toBe('REQUEST_CHANGES');
    expect(decision.fields.architecturalStatus).toBe('CLEAR');
  });

  it('marks architectural concerns on a critical blocking finding', () => {
    const decision = decideReviewBackEdge(
      input({ freshEyes: { ran: true, blocked: true, blockingSeverities: ['critical', 'high'] } }),
    );
    expect(decision.action).toBe('rewind');
    expect(decision.fields.architecturalStatus).toBe('CONCERNS');
  });

  it('any single veto field is sufficient', () => {
    // Clean review, but blocked gate → still vetoed.
    const decision = decideReviewBackEdge(
      input({
        cleanReview: { clean: true, confidence: 1, reason: 'narrated clean' },
        freshEyes: { ran: true, blocked: true, blockingSeverities: ['high'] },
      }),
    );
    expect(decision.action).toBe('rewind');
  });

  it('respects an agent that already rewound to PLAN (counts the cycle, no write)', () => {
    const decision = decideReviewBackEdge(
      input({ stageAfter: 'PLAN', cleanReview: { clean: false, confidence: 1, reason: 'bugs' } }),
    );
    expect(decision.action).toBe('rewind');
    expect(decision.needsStageWrite).toBe(false);
  });

  it('stops rewinding at the cap', () => {
    const decision = decideReviewBackEdge(
      input({ reviewCycles: 10, maxReviewCycles: 10, cleanReview: { clean: false, confidence: 1, reason: 'bugs' } }),
    );
    expect(decision.action).toBe('cap-reached');
    expect(decision.needsStageWrite).toBe(false);
  });

  it('a gate that ran clean does not veto', () => {
    const decision = decideReviewBackEdge(
      input({ freshEyes: { ran: true, blocked: false, blockingSeverities: [] } }),
    );
    expect(decision.action).toBe('none');
  });
});

describe('buildReviewBackEdgeIntervention', () => {
  it('names the cycle budget and the veto reason', () => {
    const decision = decideReviewBackEdge(
      input({ cleanReview: { clean: false, confidence: 1, reason: 'two failing modules' } }),
    );
    const message = buildReviewBackEdgeIntervention(decision, 3, 10);
    expect(message).toContain('review cycle 3/10');
    expect(message).toContain('two failing modules');
    expect(message).toContain('PLAN');
  });
});
