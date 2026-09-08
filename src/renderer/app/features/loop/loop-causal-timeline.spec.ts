/**
 * B5 — the seeded states the catalogue entry asks for (normal, paused, capped,
 * review-blocked, provider-limit), driven through the real reducer.
 *
 * The assertion that carries the feature is "what happens next WITHOUT me":
 * each blocked state must give a different, true answer. A timeline that says
 * "nothing happens" for a provider-limit park — which resumes on its own — is
 * worse than no timeline.
 */
import { describe, expect, it } from 'vitest';

import { buildLoopCausalTimeline, type LoopTimelineInput } from './loop-causal-timeline';

function state(over: Partial<LoopTimelineInput> = {}): LoopTimelineInput {
  return { status: 'running', iteration: 3, maxIterations: 50, ...over };
}

const stepIds = ['work', 'verify', 'review', 'decision'];

describe('the shape is always the same four steps', () => {
  it('renders four steps in a fixed order for a running loop', () => {
    expect(buildLoopCausalTimeline(state()).steps.map((s) => s.id)).toEqual(stepIds);
  });

  it('keeps the same four steps when blocked', () => {
    expect(buildLoopCausalTimeline(state({ status: 'cap-reached' })).steps.map((s) => s.id))
      .toEqual(stepIds);
  });

  it('marks a step skipped rather than removing it', () => {
    const timeline = buildLoopCausalTimeline(state({ hasVerifyCommand: false }));
    expect(timeline.steps.find((s) => s.id === 'verify')?.state).toBe('skipped');
    expect(timeline.steps).toHaveLength(4);
  });

  it('marks independent review skipped when the run has none', () => {
    expect(buildLoopCausalTimeline(state({ hasIndependentReview: false }))
      .steps.find((s) => s.id === 'review')?.state).toBe('skipped');
  });
});

describe('normal — running', () => {
  const timeline = buildLoopCausalTimeline(state());

  it('is not blocked', () => {
    expect(timeline.blockingStepId).toBeNull();
    expect(timeline.steps.filter((s) => s.state === 'blocked')).toEqual([]);
  });

  it('names the next iteration it will reach on its own', () => {
    expect(timeline.nextAutomaticAction).toBe('It continues to iteration 4 of 50.');
  });

  it('offers no recovery action, because nothing needs recovering', () => {
    expect(timeline.recovery.id).toBe('none');
  });

  it('does not invent an iteration number when there is no cap', () => {
    expect(buildLoopCausalTimeline(state({ maxIterations: null })).nextAutomaticAction)
      .toBe('It continues to the next iteration.');
  });
});

describe('paused', () => {
  it('blocks on work and says it will not move on its own', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'paused' }));
    expect(timeline.blockingStepId).toBe('work');
    expect(timeline.nextAutomaticAction).toContain('stays paused until you resume');
    expect(timeline.recovery.id).toBe('resume');
  });

  it('distinguishes "paused waiting for your answer" from a plain pause', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'paused', pausedForInput: true }));
    expect(timeline.blockingStepId).toBe('decision');
    expect(timeline.steps.find((s) => s.id === 'decision')?.detail)
      .toContain('asked you a question');
    expect(timeline.recovery.label).toBe('Answer and resume');
  });
});

describe('capped', () => {
  it('blocks on the terminal decision and offers a bigger cap', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'cap-reached' }));
    expect(timeline.blockingStepId).toBe('decision');
    expect(timeline.steps.find((s) => s.id === 'decision')?.detail).toContain('iteration cap');
    expect(timeline.recovery.id).toBe('raise-cap');
    expect(timeline.nextAutomaticAction).toContain('has stopped');
  });

  it('says cost, not iterations, when the cost cap was the one that bit', () => {
    expect(buildLoopCausalTimeline(state({ status: 'cost-exceeded' }))
      .steps.find((s) => s.id === 'decision')?.detail).toContain('cost cap');
  });
});

describe('review-blocked', () => {
  it('blocks on review when builder and reviewer disagree', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'needs-human-arbitration' }));
    expect(timeline.blockingStepId).toBe('review');
    expect(timeline.recovery.id).toBe('review-now');
  });

  /** A success state that still wants a person. Not a failure, and says so. */
  it('treats completed-needs-review as finished-but-asking, not failed', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'completed-needs-review' }));
    expect(timeline.blockingStepId).toBe('review');
    expect(timeline.nextAutomaticAction).toContain('this is a request, not a failure');
  });

  it('names a degraded replay-unsafe pause instead of calling the work done', () => {
    const timeline = buildLoopCausalTimeline(state({
      status: 'completed-needs-review',
      endReason: 'Iteration 3 paused for review instead of an automatic replay: Automatic replay is unsafe',
    }));
    expect(timeline.steps.find((s) => s.state === 'blocked')?.detail)
      .toContain('replay unsafe');
    expect(timeline.nextAutomaticAction).toContain('Replay is unsafe');
    expect(timeline.nextAutomaticAction).not.toContain('this is a request, not a failure');
  });
});

describe('provider-limit', () => {
  /**
   * The case a naive "blocked means stuck" reading gets wrong: a parked
   * provider-limit run resumes by itself.
   */
  it('says it will resume on its own while parked', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'provider-limit', endedAt: null }));
    expect(timeline.blockingStepId).toBe('work');
    expect(timeline.nextAutomaticAction).toContain('resumes on its own');
    expect(timeline.recovery.id).toBe('wait-or-switch-provider');
  });

  it('treats a provider-limit run with an end time as finished', () => {
    const timeline = buildLoopCausalTimeline(state({ status: 'provider-limit', endedAt: 123 }));
    expect(timeline.blockingStepId).toBeNull();
    expect(timeline.nextAutomaticAction).toContain('It continues');
  });
});

describe('spend meter', () => {
  it('labels an estimate as an estimate', () => {
    expect(buildLoopCausalTimeline(state({ spentCents: 250 })).spend.sourceLabel)
      .toBe('estimated');
  });

  it('labels a provider-reported figure as measured', () => {
    expect(buildLoopCausalTimeline(state({ spentCents: 250, spendIsProviderReported: true }))
      .spend.sourceLabel).toBe('provider-reported');
  });

  it('reports the fraction of the cap', () => {
    expect(buildLoopCausalTimeline(state({ spentCents: 500, maxCostCents: 2000 }))
      .spend.fractionOfCap).toBe(0.25);
  });

  it('has no fraction when there is no cap to be a fraction of', () => {
    expect(buildLoopCausalTimeline(state({ spentCents: 500, maxCostCents: null }))
      .spend.fractionOfCap).toBeNull();
  });

  it('clamps an overspend to the full bar rather than reporting over 100%', () => {
    expect(buildLoopCausalTimeline(state({ spentCents: 5000, maxCostCents: 2000 }))
      .spend.fractionOfCap).toBe(1);
  });
});

describe('announcement', () => {
  it('is one sentence naming the blocking step and what happens next', () => {
    const announcement = buildLoopCausalTimeline(state({ status: 'cap-reached' })).announcement;
    expect(announcement).toContain('Blocked at Terminal decision');
    expect(announcement).toContain('has stopped');
  });

  it('does not claim a block when the run is progressing', () => {
    expect(buildLoopCausalTimeline(state()).announcement).not.toContain('Blocked');
  });

  it('is stable for the same state, so a host can announce it once per change', () => {
    expect(buildLoopCausalTimeline(state({ status: 'paused' })).announcement)
      .toBe(buildLoopCausalTimeline(state({ status: 'paused' })).announcement);
  });
});
