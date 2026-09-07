/**
 * B4 — the summary's whole job is to be true about the CURRENT values, so every
 * test here flips a field and checks the sentence changed with it. The original
 * bug was a summary that kept describing a policy the run no longer had.
 */
import { describe, expect, it } from 'vitest';

import { buildLoopPreflightSummary, type LoopPreflightInput } from './loop-preflight-summary';

function input(over: Partial<LoopPreflightInput> = {}): LoopPreflightInput {
  return {
    maxIterations: 50,
    maxDollars: 20,
    allowDestructive: false,
    managedIsolation: true,
    completionMode: 'review-driven',
    requiredCleanPasses: 2,
    initialStage: 'IMPLEMENT',
    operatorReviewedCompletion: false,
    freshEyesReview: true,
    ...over,
  };
}

describe('buildLoopPreflightSummary', () => {
  it('says where it works', () => {
    expect(buildLoopPreflightSummary(input())).toContain('its own isolated checkout');
  });

  it('says plainly when there is no isolation', () => {
    expect(buildLoopPreflightSummary(input({ managedIsolation: false })))
      .toContain('directly in your working checkout, with no isolation');
  });

  /** The exact bug: this sentence must follow the switch, not the preset. */
  it('follows the destructive-command switch', () => {
    expect(buildLoopPreflightSummary(input())).toContain('cannot run destructive commands');
    expect(buildLoopPreflightSummary(input({ allowDestructive: true })))
      .toContain('allowed to run destructive commands');
  });

  it('names the stage it starts on', () => {
    expect(buildLoopPreflightSummary(input({ initialStage: 'PLAN' }))).toContain('planning');
    expect(buildLoopPreflightSummary(input({ initialStage: 'REVIEW' }))).toContain('reviewing');
    expect(buildLoopPreflightSummary(input())).toContain('implementing');
  });

  it('says the operator decides when they hold the completion decision', () => {
    expect(buildLoopPreflightSummary(input({ operatorReviewedCompletion: true })))
      .toContain('You decide when it is done');
  });

  it('distinguishes an independent reviewer from self-review', () => {
    expect(buildLoopPreflightSummary(input({ freshEyesReview: true })))
      .toContain('independent fresh-eyes reviewer');
    expect(buildLoopPreflightSummary(input({ freshEyesReview: false })))
      .toContain('its own review');
  });

  it('agrees with the number of clean passes required', () => {
    expect(buildLoopPreflightSummary(input({ requiredCleanPasses: 1 })))
      .toContain('1 consecutive clean pass.');
    expect(buildLoopPreflightSummary(input({ requiredCleanPasses: 3 })))
      .toContain('3 consecutive clean passes');
  });

  it('quotes the verify command on a gated run', () => {
    expect(buildLoopPreflightSummary(input({ completionMode: 'gated', verifyCommand: 'npm test' })))
      .toContain('`npm test` passes');
  });

  /** A gated run with no verify command has nothing checking the claim. */
  it('says so when a gated run has no verify command', () => {
    expect(buildLoopPreflightSummary(input({ completionMode: 'gated' })))
      .toContain('no verify command to check that claim');
  });

  it('states both caps and which bites first', () => {
    expect(buildLoopPreflightSummary(input()))
      .toContain('stops after 50 iterations or $20, whichever comes first');
  });

  it('states a single cap without the "whichever" clause', () => {
    expect(buildLoopPreflightSummary(input({ maxDollars: null })))
      .toContain('stops after 50 iterations.');
  });

  /** An unbounded run is legitimate, but the operator should know. */
  it('says outright when nothing bounds the run', () => {
    expect(buildLoopPreflightSummary(input({ maxIterations: null, maxDollars: null })))
      .toContain('no iteration or cost cap');
  });
});
