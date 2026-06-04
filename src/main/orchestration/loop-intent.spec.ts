import { describe, expect, it } from 'vitest';
import {
  detectConvergeUntilCleanIntent,
  detectLoopGoalIntent,
  looksLikeConvergeUntilCleanIntent,
} from './loop-intent';

describe('detectConvergeUntilCleanIntent', () => {
  it('matches the canonical "fresh eyes ... until no issues" prompt', () => {
    const r = detectConvergeUntilCleanIntent(
      'Keep doing a review with fresh eyes and fix any issues, until there are no issues.',
    );
    expect(r.matched).toBe(true);
    // "fresh eyes" is a strong standalone signal.
    expect(r.reason).toBe('fresh-eyes-phrase');
  });

  it('matches "fresh-eyes" hyphenated spelling', () => {
    expect(looksLikeConvergeUntilCleanIntent('do a fresh-eyes pass')).toBe(true);
  });

  it('matches review verb + convergence cue without the "fresh eyes" phrase', () => {
    const r = detectConvergeUntilCleanIntent('Review the diff and keep fixing until it is clean');
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('review-verb+convergence-cue');
  });

  it('matches "until there are no bugs" with an audit verb', () => {
    expect(looksLikeConvergeUntilCleanIntent('Audit the codebase until there are no bugs left')).toBe(true);
  });

  it('matches the cue in the iterationPrompt even when the goal is plain', () => {
    expect(
      looksLikeConvergeUntilCleanIntent('Implement the feature', 'please continue, re-review with fresh eyes'),
    ).toBe(true);
  });

  it('does NOT match a plain implementation goal', () => {
    const r = detectConvergeUntilCleanIntent('implement plan.md');
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('none');
  });

  it('does NOT match a review request with no convergence cue (one-shot review)', () => {
    // A single review pass is not the converge-until-clean intent.
    expect(looksLikeConvergeUntilCleanIntent('review my code and tell me what you think')).toBe(false);
  });

  it('does NOT match a convergence cue with no review verb (build loop, not review loop)', () => {
    // "until it passes" is a convergence cue, but with no evaluative verb this
    // is a build loop — we must NOT auto-enable cross-model review for it.
    expect(looksLikeConvergeUntilCleanIntent('keep building until it passes')).toBe(false);
    expect(looksLikeConvergeUntilCleanIntent('build the project and ship it')).toBe(false);
  });
});

describe('detectLoopGoalIntent', () => {
  it('classifies the canonical audit question as investigation', () => {
    const r = detectLoopGoalIntent(
      'Is this fully implemented? Please be thorough and check against actual code.',
    );
    expect(r.intent).toBe('investigation');
    // "is this … implemented" status form OR the question lead both qualify.
    expect(['status-question', 'question-form']).toContain(r.reason);
  });

  it('classifies explicit explain/audit verbs as investigation', () => {
    expect(detectLoopGoalIntent('Explain how the loop coordinator works').intent).toBe('investigation');
    expect(detectLoopGoalIntent('Audit the auth module for security gaps').intent).toBe('investigation');
    expect(detectLoopGoalIntent("What's causing the timeout cascade?").intent).toBe('investigation');
  });

  it('treats a participle inside a question as investigation, not implementation', () => {
    // "implemented" must NOT trip the implementation-verb matcher (base-form
    // word boundary) — otherwise the audit goal would be misread as a build.
    const r = detectLoopGoalIntent('Is the mobile gateway implemented and wired up?');
    expect(r.intent).toBe('investigation');
  });

  it('classifies imperative implementation goals as implementation (wins on ambiguity)', () => {
    expect(detectLoopGoalIntent('Implement everything in the plan').intent).toBe('implementation');
    expect(detectLoopGoalIntent('Add a dark-mode toggle to settings').intent).toBe('implementation');
    expect(detectLoopGoalIntent('Refactor the adapter layer').intent).toBe('implementation');
    // Question-shaped but asks for a code change → implementation.
    expect(detectLoopGoalIntent('Can you fix the failing tests?').intent).toBe('implementation');
  });

  it('classifies a review-and-fix (converge) goal as implementation, not investigation', () => {
    // It mutates code, so it is an implement loop even though it mentions review.
    expect(detectLoopGoalIntent('Review the diff and fix any issues until clean').intent).toBe(
      'implementation',
    );
  });

  it('defaults to implementation for an empty or non-question goal', () => {
    expect(detectLoopGoalIntent('').reason).toBe('empty');
    expect(detectLoopGoalIntent('the parser module').intent).toBe('implementation');
  });
});
