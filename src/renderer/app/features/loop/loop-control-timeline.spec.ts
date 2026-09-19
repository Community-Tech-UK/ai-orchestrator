import { describe, expect, it } from 'vitest';
import { loopTimelineForRun, timelineRecoveryTarget } from './loop-control-timeline';

function run(lastIteration?: { costKnown?: boolean } | null) {
  return {
    status: 'running',
    endedAt: null,
    totalIterations: 3,
    totalCostCents: 250,
    lastIteration,
  };
}

describe('loopTimelineForRun spend provenance', () => {
  it('labels spend provider-reported when the last iteration had an authoritative cost', () => {
    expect(loopTimelineForRun(run({ costKnown: true }))?.spend.sourceLabel)
      .toBe('provider-reported');
  });

  it.each([
    ['an estimated cost', { costKnown: false }],
    ['no recorded provenance', {}],
    ['no last iteration', null],
  ])('labels spend estimated with %s', (_label, lastIteration) => {
    expect(loopTimelineForRun(run(lastIteration))?.spend.sourceLabel).toBe('estimated');
  });

  it('returns null without a run', () => {
    expect(loopTimelineForRun(null)).toBeNull();
  });
});

describe('timelineRecoveryTarget', () => {
  it('maps resume-style recoveries to the resume action', () => {
    expect(timelineRecoveryTarget('resume')).toBe('resume');
    expect(timelineRecoveryTarget('raise-cap')).toBe('resume');
  });

  it('leaves the deliberate no-ops unrouted', () => {
    expect(timelineRecoveryTarget('review-now')).toBeNull();
    expect(timelineRecoveryTarget('wait-or-switch-provider')).toBeNull();
    expect(timelineRecoveryTarget('none')).toBeNull();
  });
});

describe('loopTimelineForRun for a provider-limit park', () => {
  it('says the loop resumes on its own and offers no button, since no setting gates a loop resume', () => {
    const timeline = loopTimelineForRun({
      status: 'provider-limit',
      endedAt: null,
      totalIterations: 1,
      totalCostCents: 0,
    });
    expect(timeline?.nextAutomaticAction).toContain('resumes on its own');
    expect(timeline?.recovery.id).toBe('wait-or-switch-provider');
    expect(timelineRecoveryTarget(timeline!.recovery.id)).toBeNull();
  });
});
