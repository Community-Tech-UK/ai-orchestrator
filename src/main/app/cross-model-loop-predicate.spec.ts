import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-loop-predicate', getVersion: () => '0.0.0-test', isPackaged: false } }));
import * as reviews from '../orchestration/cross-model-review-service';
import * as loops from '../orchestration/loop-coordinator';
import { createLateRuntimeInitializationSteps } from './late-runtime-initialization-steps';
import type { AppInitializationContext } from './initialization-steps';
import type { LoopState } from '../../shared/types/loop.types';

describe('Cross-model active-loop initialization', () => {
  it('installs a live ownership predicate before initializing reviews', async () => {
    let active: Pick<LoopState, 'chatId' | 'status' | 'endedAt'>[] = [];
    let predicate: ((id: string) => boolean) | undefined;
    const review = { setInstanceManager: vi.fn(), setActiveLoopPredicate: vi.fn((fn: (id: string) => boolean) => { predicate = fn; }), setReviewExecutionHost: vi.fn(), initialize: vi.fn(async () => { expect(predicate).toBeDefined(); }) };
    const reviewSpy = vi.spyOn(reviews, 'getCrossModelReviewService').mockReturnValue(review as unknown as reviews.CrossModelReviewService);
    const loopSpy = vi.spyOn(loops, 'getLoopCoordinator').mockReturnValue({ getActiveLoops: () => active } as unknown as loops.LoopCoordinator);
    try {
      const step = createLateRuntimeInitializationSteps({ instanceManager: {}, windowManager: {} } as AppInitializationContext).find((entry) => entry.name === 'Cross-model review');
      await step!.fn();
      expect(predicate!('ordinary')).toBe(false);
      active = [
        { chatId: 'running', status: 'running', endedAt: null },
        { chatId: 'paused', status: 'paused', endedAt: null },
        { chatId: 'parked', status: 'provider-limit', endedAt: null },
        { chatId: 'ended-quota', status: 'provider-limit', endedAt: 1 },
        { chatId: 'failed', status: 'attempt-failed', endedAt: 1 },
        { chatId: 'done', status: 'completed', endedAt: 1 },
      ];
      for (const id of ['running', 'paused', 'parked']) expect(predicate!(id)).toBe(true);
      for (const id of ['ordinary', 'ended-quota', 'failed', 'done']) expect(predicate!(id)).toBe(false);
      active = [];
      expect(predicate!('running')).toBe(false);
    } finally { reviewSpy.mockRestore(); loopSpy.mockRestore(); }
  });
});
