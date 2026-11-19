import { describe, expect, it } from 'vitest';
import { planQueueDocumentLabel, planQueueKindLabel, planQueueTicketAnswerBlock, planQueueWaitsForTicketAnswer } from './plan-queue-item-display';

describe('planQueueDocumentLabel', () => {
  it.each([
    ['/a/b/desk-shared-crm_plan.md', 'desk-shared-crm'],
    ['C:\\a\\desk-colleague-sending_spec.md', 'desk-colleague-sending'],
    ['docs/plans/foo_spec_planned.md', 'foo'], ['docs/plans/foo_livetest.md', 'foo'],
  ])('labels %s without lifecycle suffix', (path, label) => expect(planQueueDocumentLabel(path)).toBe(label));
});

describe('planQueueKindLabel', () => {
  it.each([['plans', 'Plans'], ['livetests', 'Live checks'], ['tickets', 'Linear tickets']] as const)('names %s in plain words', (kind, label) => {
    expect(planQueueKindLabel(kind)).toBe(label);
  });
});

describe('a job waiting for the answer about its ticket', () => {
  const held = { options: [], question: 'ORC-12 changed in Linear. Answer on the Plan Queue page.', jamesOnly: true as const };
  const ordinary = { options: [], question: 'Which?' };

  it('waits only while it has a question for James alone and is not finished', () => {
    expect(planQueueWaitsForTicketAnswer({ question: held, state: 'queued' })).toBe(true);
    expect(planQueueWaitsForTicketAnswer({ question: held, state: 'parked' })).toBe(true);
    expect(planQueueWaitsForTicketAnswer({ question: held, state: 'landed' })).toBe(false);
    expect(planQueueWaitsForTicketAnswer({ question: held, state: 'skipped' })).toBe(false);
    expect(planQueueWaitsForTicketAnswer({ question: held, state: 'parked', discardedAt: 5 })).toBe(false);
    expect(planQueueWaitsForTicketAnswer({ question: ordinary, state: 'queued' })).toBe(false);
    expect(planQueueWaitsForTicketAnswer({ question: null, state: 'queued' })).toBe(false);
  });

  it('gives the reason the main process gives', () => {
    expect(planQueueTicketAnswerBlock({ question: held, state: 'queued' })).toBe('Answer the question about this ticket first.');
    expect(planQueueTicketAnswerBlock({ question: ordinary, state: 'queued' })).toBeNull();
  });
});
