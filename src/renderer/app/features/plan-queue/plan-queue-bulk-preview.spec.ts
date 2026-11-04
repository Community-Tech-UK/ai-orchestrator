import { describe, expect, it } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { planQueueBulkResumePreview } from './plan-queue-bulk-preview';

const item = (id: string, overrides: Partial<PlanQueueItemDto> = {}) => ({
  id, state: 'parked', documentPath: '/repo/a_plan.md', branchName: `queue/${id}`,
  worktreePath: null, parkReason: 'round-limit', updatedAt: 1, detail: null, ...overrides,
} as PlanQueueItemDto);

describe('bulk resume preview', () => {
  it('resumes only the newest attempt and leaves busy or discarded work alone', () => {
    const preview = planQueueBulkResumePreview([
      item('old'), item('new', { updatedAt: 2 }),
      item('busy', { documentPath: '/repo/b_plan.md' }),
      item('discarded', { documentPath: '/repo/c_plan.md', branchName: null, detail: 'Discarded by James.' }),
      item('different', { documentPath: '/repo/d_plan.md', parkReason: 'worker-error' }),
    ], 'round-limit', ['/repo/b_plan.md']);
    expect(preview.willChange.map(entry => entry.id)).toEqual(['new']);
    expect(preview.leftAlone.map(entry => entry.item.id).sort()).toEqual(['busy', 'discarded', 'old']);
    expect(preview.notApplicable.map(entry => entry.item.id)).toEqual(['different']);
  });
});
