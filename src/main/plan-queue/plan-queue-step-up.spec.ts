import { describe, expect, it } from 'vitest';
import { canStepUp } from './plan-queue-step-up';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const runWith = (stepUp: boolean) => ({ config: { routing: stepUp ? { stepUp: { provider: 'claude', model: 'opus' } } : {} } }) as unknown as PlanQueueRun;
const item = (steppedUpAt: number | null = null) => ({ steppedUpAt }) as unknown as PlanQueueItem;
const finding = (kind?: 'code' | 'environment' | 'needs-human') => ({ severity: 'high' as const, confidence: 90, summary: 'x', ...(kind ? { kind } : {}) });

describe('canStepUp (step 5.4)', () => {
  it('steps up when a code finding is listed, including one with no kind (stored before kinds existed)', () => {
    expect(canStepUp(runWith(true), item(), { findings: [finding('code')] })).toBe(true);
    expect(canStepUp(runWith(true), item(), { findings: [finding()] })).toBe(true);
    expect(canStepUp(runWith(true), item(), { findings: [finding('environment'), finding('code')] })).toBe(true);
  });

  it('does not step up when the findings are empty or none is code', () => {
    expect(canStepUp(runWith(true), item(), { findings: [] })).toBe(false);
    expect(canStepUp(runWith(true), item(), { findings: [finding('environment')] })).toBe(false);
    expect(canStepUp(runWith(true), item(), { findings: [finding('needs-human'), finding('environment')] })).toBe(false);
  });

  it('keeps the earlier rules: a step-up choice is needed and a document is handed over once', () => {
    expect(canStepUp(runWith(false), item(), { findings: [finding('code')] })).toBe(false);
    expect(canStepUp(runWith(true), item(1_700_000_000_000), { findings: [finding('code')] })).toBe(false);
  });
});
