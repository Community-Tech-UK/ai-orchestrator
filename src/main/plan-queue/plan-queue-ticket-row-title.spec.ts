/** A ticket's row is named with its identifier and approved title, on the page's item list and on the phone's row. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('./plan-queue-linear-ticket-store-singleton', () => ({
  getPlanQueueLinearTicketStore: () => ({ findNames: (id: string) => (id === 'lin-12' ? { identifier: 'ORC-12', approvedTitle: 'Make the sign-in button work' } : undefined) }),
}));

import { projectPlanQueueItem } from '../mobile-gateway/mobile-gateway-plan-queue-source';
import { itemToDto } from './plan-queue-messages';
import { newPlanQueueItem } from './plan-queue-state';

describe('row titles', () => {
  const ticket = newPlanQueueItem('item-1', 'run-1', 'linear:lin-12', 1, { sourceKind: 'linear' });
  const document = newPlanQueueItem('item-2', 'run-1', '/repo/docs/plans/a_plan.md', 1);

  it('sends a ticket\'s identifier and approved title as its title', () => {
    expect(itemToDto(ticket, undefined).title).toBe('ORC-12 Make the sign-in button work');
  });

  it('sends no title for a document, so the page names it from the path as before', () => {
    expect(itemToDto(document, undefined)).not.toHaveProperty('title');
  });

  it('puts the title on the phone\'s row when there is one, and the file name when there is not', () => {
    expect(projectPlanQueueItem(itemToDto(ticket, undefined)).title).toBe('ORC-12 Make the sign-in button work');
    expect(projectPlanQueueItem(itemToDto(document, undefined)).title).toBe('a_plan.md');
  });

  it('carries the held ticket\'s James-only flag and fixed sentence to the page and to the phone\'s row, and nothing else', () => {
    const sentence = 'ORC-12 changed in Linear. Answer on the Plan Queue page.';
    const held = { ...ticket, state: 'queued' as const, question: { question: sentence, jamesOnly: true, options: [{ id: 'stop', label: 'Stop work on this ticket' }, { id: 'leave-waiting', label: 'Leave it waiting' }] } };
    const page = itemToDto(held, undefined);
    expect(page.question).toEqual(held.question);
    const phone = projectPlanQueueItem(page);
    expect(phone.question).toEqual(held.question);
    expect(Object.keys(phone)).not.toContain('worktreePath');
  });
});
