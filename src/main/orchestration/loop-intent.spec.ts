import { describe, expect, it } from 'vitest';
import { detectConvergeUntilCleanIntent, looksLikeConvergeUntilCleanIntent } from './loop-intent';

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
