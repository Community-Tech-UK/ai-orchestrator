import { describe, expect, it } from 'vitest';
import { PlanQueueAlertSchema, PlanQueueQuestionSchema, PlanQueueReportTriageArgsSchema, PlanQueueControlPayloadSchema, PlanQueueControlArgsSchema } from '../plan-queue.schemas';

const question = {
  question: 'Which existing verification command should the worker use?',
  options: [{ id: 'quiet', label: 'Use the documented quiet runner' }, { id: 'skip', label: 'Leave the document alone' }],
};
const technical = {
  kind: 'technical', recommendedOptionId: 'quiet', reason: 'The project requires this runner.', evidence: 'AGENTS.md documents npm run test:quiet.',
};

describe('Plan Queue checkout alerts', () => {
  it('preserves bounded invalid-checkout advice and keeps legacy alerts valid', () => {
    const alert = {
      kind: 'invalid-worktree', path: '/repo/.worktrees/queue/item', itemId: 'item',
      reason: 'Saved checkout is unusable.', suggestedAction: 'Review the item details before explicitly approving Discard.',
    };
    expect(PlanQueueAlertSchema.parse(alert)).toEqual(alert);
    expect(PlanQueueAlertSchema.parse({ kind: 'missing-worktree', itemId: 'item' })).toEqual({ kind: 'missing-worktree', itemId: 'item' });
  });

  it.each(['reason', 'suggestedAction'])('rejects oversized %s instead of exposing raw diagnostics', (field) => {
    expect(PlanQueueAlertSchema.safeParse({ kind: 'invalid-worktree', [field]: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('Plan Queue readiness decisions', () => {
  it('preserves evidence-backed technical metadata through triage parsing', () => {
    const parsed = PlanQueueReportTriageArgsSchema.parse({
      run_id: 'run-1', records: [{ documentPath: '/repo/a_plan.md', disposition: 'needs-answer', question: { ...question, decision: technical } }],
    });
    expect(parsed.records[0]).toMatchObject({ question: { decision: technical } });
  });

  it('keeps old unclassified questions valid without inventing a decision', () => {
    expect(PlanQueueQuestionSchema.parse(question)).toEqual(question);
  });

  it.each(['human-authority', 'human-input'])('preserves a %s boundary', (kind) => {
    const decision = { kind, reason: 'Requires a fact or authority only James can provide.' };
    expect(PlanQueueQuestionSchema.parse({ ...question, decision })).toMatchObject({ decision });
  });

  it.each([
    { ...technical, recommendedOptionId: 'missing' },
    { ...technical, recommendedOptionId: 'skip' },
    { ...technical, reason: '' },
    { ...technical, evidence: '' },
    { ...technical, reason: '   ' },
    { ...technical, evidence: '   ' },
    { ...technical, recommendedOptionId: 'x'.repeat(51) },
    { ...technical, reason: 'x'.repeat(4001) },
    { ...technical, evidence: 'x'.repeat(8001) },
    { kind: 'unknown', reason: 'Unsupported classification' },
    { kind: 'human-authority', reason: 'Requires approval', recommendedOptionId: 'quiet' },
  ])('rejects invalid decision metadata %#', (decision) => {
    expect(PlanQueueQuestionSchema.safeParse({ ...question, decision }).success).toBe(false);
  });

  it('rejects duplicate option identifiers', () => {
    expect(PlanQueueQuestionSchema.safeParse({
      ...question, options: [{ id: 'quiet', label: 'First' }, { id: 'quiet', label: 'Second' }], decision: technical,
    }).success).toBe(false);
  });
});


describe('Plan Queue routing controls', () => {
  it('accepts panel-only bulk actions and a complete per-run routing change', () => {
    expect(PlanQueueControlPayloadSchema.parse({ action: 'pause-all' })).toEqual({ action: 'pause-all' });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'resume-all' })).toEqual({ action: 'resume-all' });
    expect(PlanQueueControlPayloadSchema.parse({ action: 'set-routing', runId: 'run', routing: { worker: null, verifiers: [] }, moveInProgress: true })).toMatchObject({ moveInProgress: true });
  });
  it('uses snake_case routing choices over MCP and refuses bulk actions', () => {
    expect(PlanQueueControlArgsSchema.parse({ action: 'set-routing', run_id: 'run', routing: { worker: { provider: 'codex', account_ids: ['account'] }, verifiers: [] }, move_in_progress: true })).toMatchObject({ move_in_progress: true });
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'pause-all' }).success).toBe(false);
    expect(PlanQueueControlArgsSchema.safeParse({ action: 'set-routing', run_id: 'run' }).success).toBe(false);
  });
});
