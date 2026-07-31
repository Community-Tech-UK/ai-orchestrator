import { describe, expect, it } from 'vitest';
import {
  OperationalDecisionSchema,
  WorkboardDecisionsForItemPayloadSchema,
} from '../workboard.schemas';

describe('WorkboardDecisionsForItemPayloadSchema', () => {
  it('accepts a payload with a single correlating id', () => {
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse({ loopRunId: 'loop-1' }).success).toBe(true);
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse({ automationRunId: 'run-1' }).success).toBe(true);
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(true);
  });

  it('accepts a payload with every id present', () => {
    const result = WorkboardDecisionsForItemPayloadSchema.safeParse({
      loopRunId: 'loop-1', automationRunId: 'run-1', instanceId: 'inst-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload with no correlating id at all', () => {
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a completely malformed payload', () => {
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse(null).success).toBe(false);
    expect(WorkboardDecisionsForItemPayloadSchema.safeParse('loop-1').success).toBe(false);
  });
});

describe('OperationalDecisionSchema', () => {
  const base = {
    id: 'pl:evt-1',
    at: 1_000,
    source: 'provider-limit' as const,
    title: 'Paused: Claude hit its usage limit',
  };

  it('accepts the minimal required shape', () => {
    expect(OperationalDecisionSchema.safeParse(base).success).toBe(true);
  });

  it('accepts every optional field populated, including the resume-loop action', () => {
    const result = OperationalDecisionSchema.safeParse({
      ...base,
      detail: 'Recorded via loop-quota',
      resultingStatus: 'provider-limit',
      resumeAt: 2_000,
      operatorAction: { kind: 'resume-loop', label: 'Resume now', loopRunId: 'loop-1' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null resumeAt (unknown resume time)', () => {
    expect(OperationalDecisionSchema.safeParse({ ...base, resumeAt: null }).success).toBe(true);
  });

  it('rejects an unrecognized source — the union is a closed taxonomy', () => {
    expect(OperationalDecisionSchema.safeParse({ ...base, source: 'made-up' }).success).toBe(false);
  });

  it('rejects an operator action kind other than resume-loop', () => {
    const result = OperationalDecisionSchema.safeParse({
      ...base,
      operatorAction: { kind: 'delete-everything', label: 'Nope', loopRunId: 'loop-1' },
    });
    expect(result.success).toBe(false);
  });
});
