import { describe, expect, it } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { planQueueBulkResumePreview, planQueueBulkRetryPreview } from './plan-queue-bulk-preview';

const item = (id: string, overrides: Partial<PlanQueueItemDto> = {}) => ({
  id, state: 'parked', documentPath: '/repo/a_plan.md', branchName: `queue/${id}`,
  worktreePath: null, parkReason: 'round-limit', createdAt: 1, updatedAt: 1, detail: null, ...overrides,
} as PlanQueueItemDto);

describe('bulk resume preview', () => {
  it('resumes only the newest attempt and leaves busy or discarded work alone', () => {
    const preview = planQueueBulkResumePreview([
      item('old', { updatedAt: 9 }), item('new', { createdAt: 2 }),
      item('busy', { documentPath: '/repo/b_plan.md' }),
      item('discarded', { documentPath: '/repo/c_plan.md', branchName: null, discardedAt: 1 }),
      item('different', { documentPath: '/repo/d_plan.md', parkReason: 'worker-error' }),
    ], 'round-limit', ['/repo/b_plan.md'], new Map());
    expect(preview.willChange.map(entry => entry.id)).toEqual(['new']);
    expect(preview.leftAlone.map(entry => entry.item.id).sort()).toEqual(['busy', 'discarded', 'old']);
    expect(preview.notApplicable.map(entry => entry.item.id)).toEqual(['different']);
  });

  it('leaves alone an attempt older than the document\'s last merge, but not one made after it', () => {
    const preview = planQueueBulkResumePreview([
      item('merged-since', { createdAt: 5, updatedAt: 99 }),
      item('newer-than-merge', { documentPath: '/repo/b_plan.md', createdAt: 9, updatedAt: 9 }),
    ], 'round-limit', [], new Map([['/repo/a_plan.md', 6], ['/repo/b_plan.md', 6]]));
    expect(preview.willChange.map(entry => entry.id)).toEqual(['newer-than-merge']);
    expect(preview.leftAlone[0].reason).toBe('a newer attempt already merged');
  });

  it.each(['land-blocked', 'merge-conflict'] as const)('never resumes %s work that passed its checks', (parkReason) => {
    const verdict = { verdict: 'PASS' } as PlanQueueItemDto['verdict'];
    const preview = planQueueBulkResumePreview([item('passed', { parkReason, verdict })], parkReason, [], new Map());
    expect(preview.willChange).toEqual([]);
    expect(preview.leftAlone[0].reason).toContain('passed its checks');
  });

  it('retries the oldest job first and leaves a busy document alone', () => {
    const preview = planQueueBulkRetryPreview([
      item('newer', { documentPath: '/repo/b_plan.md', createdAt: 5 }),
      item('older', { documentPath: '/repo/c_plan.md', createdAt: 2 }),
      item('busy', { documentPath: '/repo/d_plan.md', createdAt: 1 }),
    ], ['/repo/d_plan.md'], new Set());
    expect(preview.willChange.map(entry => entry.id)).toEqual(['older', 'newer']);
    expect(preview.leftAlone.map(entry => entry.item.id)).toEqual(['busy']);
  });

  it('leaves alone a job whose run is paused, because it would only queue behind the pause', () => {
    const preview = planQueueBulkRetryPreview([item('held', { runId: 'paused' }), item('free', { documentPath: '/repo/b_plan.md', runId: 'open' })], [], new Set(['paused']));
    expect(preview.willChange.map(entry => entry.id)).toEqual(['free']);
    expect(preview.leftAlone[0]).toMatchObject({ reason: 'its run is paused' });
  });
});
