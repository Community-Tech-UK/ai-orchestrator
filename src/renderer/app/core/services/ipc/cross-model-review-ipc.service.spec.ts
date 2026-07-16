import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CrossModelReviewIpcService } from './cross-model-review-ipc.service';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  AggregatedReview,
  CrossModelReviewStatus,
} from '../../../../../shared/types/cross-model-review.types';

type Cb<T> = (data: T) => void;

/** Captures the event callbacks the service registers so tests can fire them. */
class FakeApi {
  onStarted?: Cb<{ instanceId: string; reviewId: string }>;
  onResult?: Cb<AggregatedReview>;
  onDiscarded?: Cb<{ instanceId: string; reviewId: string; reason: 'superseded' }>;
  onAllUnavailable?: Cb<{ instanceId: string; reviewId: string }>;
  onReviewerUnavailable?: Cb<{ dropped: { cli: string; error?: string }[] }>;
  onReviewerRateLimited?: Cb<{ instanceId?: string; cliType: string }>;
  onReviewerRateLimitCleared?: Cb<{ cliType: string }>;

  crossModelReviewOnStarted = (cb: FakeApi['onStarted']): void => { this.onStarted = cb; };
  crossModelReviewOnResult = (cb: FakeApi['onResult']): void => { this.onResult = cb; };
  crossModelReviewOnDiscarded = (cb: FakeApi['onDiscarded']): void => { this.onDiscarded = cb; };
  crossModelReviewOnAllUnavailable = (cb: FakeApi['onAllUnavailable']): void => {
    this.onAllUnavailable = cb;
  };
  crossModelReviewOnReviewerUnavailable = (cb: FakeApi['onReviewerUnavailable']): void => {
    this.onReviewerUnavailable = cb;
  };
  crossModelReviewOnReviewerRateLimited = (cb: FakeApi['onReviewerRateLimited']): void => {
    this.onReviewerRateLimited = cb;
  };
  crossModelReviewOnReviewerRateLimitCleared = (cb: FakeApi['onReviewerRateLimitCleared']): void => {
    this.onReviewerRateLimitCleared = cb;
  };
  status: CrossModelReviewStatus | null = null;
  crossModelReviewStatus = async (): Promise<CrossModelReviewStatus | null> => this.status;
}

class FakeIpc {
  readonly api = new FakeApi();
  getApi(): unknown {
    return this.api;
  }
}

describe('CrossModelReviewIpcService — reviewer notices', () => {
  let ipc: FakeIpc;
  let service: CrossModelReviewIpcService;

  beforeEach(() => {
    ipc = new FakeIpc();
    TestBed.configureTestingModule({
      providers: [
        CrossModelReviewIpcService,
        { provide: ElectronIpcService, useValue: ipc },
      ],
    });
    service = TestBed.inject(CrossModelReviewIpcService);
  });

  it('records an unavailable reviewer and clears it when the set recovers', () => {
    ipc.api.onReviewerUnavailable?.({ dropped: [{ cli: 'antigravity', error: 'not on PATH' }] });
    expect(service.getReviewerNotice('antigravity')?.kind).toBe('unavailable');

    // Recovery: the next event carries the current (now empty) set.
    ipc.api.onReviewerUnavailable?.({ dropped: [] });
    expect(service.getReviewerNotice('antigravity')).toBeUndefined();
  });

  it('records a rate-limited reviewer and clears it on the cleared event', () => {
    ipc.api.onReviewerRateLimited?.({ cliType: 'copilot' });
    expect(service.getReviewerNotice('copilot')?.kind).toBe('rate-limited');

    ipc.api.onReviewerRateLimitCleared?.({ cliType: 'copilot' });
    expect(service.getReviewerNotice('copilot')).toBeUndefined();
  });

  it('preserves a rate-limited notice when the unavailable set is replaced', () => {
    ipc.api.onReviewerRateLimited?.({ cliType: 'copilot' });
    ipc.api.onReviewerUnavailable?.({ dropped: [{ cli: 'antigravity' }] });
    ipc.api.onReviewerUnavailable?.({ dropped: [] }); // antigravity recovers

    expect(service.getReviewerNotice('antigravity')).toBeUndefined();
    expect(service.getReviewerNotice('copilot')?.kind).toBe('rate-limited');
  });

  it('does not clear an unavailable notice via a stray rate-limit-cleared event', () => {
    ipc.api.onReviewerUnavailable?.({ dropped: [{ cli: 'antigravity' }] });
    ipc.api.onReviewerRateLimitCleared?.({ cliType: 'antigravity' });
    expect(service.getReviewerNotice('antigravity')?.kind).toBe('unavailable');
  });

  it('rehydrates notices from the status snapshot (survives reload / persistent unavailability)', async () => {
    ipc.api.status = {
      enabled: true,
      reviewers: [{ cliType: 'copilot', available: true, rateLimited: true, totalReviews: 3 }],
      pendingReviews: 0,
      unavailableReviewers: [{ cli: 'antigravity', error: 'not on PATH' }],
    };

    await service.refreshStatus();

    expect(service.getReviewerNotice('antigravity')?.kind).toBe('unavailable');
    expect(service.getReviewerNotice('antigravity')?.reason).toBe('not on PATH');
    expect(service.getReviewerNotice('copilot')?.kind).toBe('rate-limited');
  });

  it('keeps an empty local failure result visible and clears pending state', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-1' });
    const result: AggregatedReview = {
      id: 'review-1',
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      localReviewer: {
        reviewerId: 'local-model',
        source: 'local',
        status: 'failed',
        reason: 'endpoint stopped',
      },
      hasDisagreement: false,
      timestamp: 1,
    };

    ipc.api.onResult?.(result);

    expect(service.getReviewForInstance('inst-1')).toEqual(result);
    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(false);
  });

  it('clears pending state quietly when a superseded review is discarded', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-1' });
    expect(service.pendingInstances().has('inst-1')).toBe(true);

    ipc.api.onDiscarded?.({
      instanceId: 'inst-1',
      reviewId: 'review-1',
      reason: 'superseded',
    });

    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(false);
    expect(service.getReviewForInstance('inst-1')).toBeUndefined();
  });

  it('keeps a newer overlapping review pending when an older review is discarded', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });

    ipc.api.onDiscarded?.({
      instanceId: 'inst-1',
      reviewId: 'review-a',
      reason: 'superseded',
    });

    expect(service.pendingInstances().has('inst-1')).toBe(true);

    ipc.api.onResult?.({
      id: 'review-b',
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      timestamp: 2,
    });
    expect(service.pendingInstances().has('inst-1')).toBe(false);
  });

  it('keeps a newer overlapping review pending when an older review is unavailable', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });

    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-a' });

    expect(service.pendingInstances().has('inst-1')).toBe(true);
    expect(service.skippedInstances().has('inst-1')).toBe(false);

    ipc.api.onDiscarded?.({
      instanceId: 'inst-1',
      reviewId: 'review-b',
      reason: 'superseded',
    });
    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(false);
  });

  it.each(['newer-first', 'older-first'] as const)(
    'keeps the newer unavailable outcome when overlapping terminals arrive %s',
    (terminalOrder) => {
      ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
      ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });

      const newerUnavailable = (): void => {
        ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-b' });
      };
      const olderDiscarded = (): void => {
        ipc.api.onDiscarded?.({
          instanceId: 'inst-1',
          reviewId: 'review-a',
          reason: 'superseded',
        });
      };

      if (terminalOrder === 'newer-first') {
        newerUnavailable();
        olderDiscarded();
      } else {
        olderDiscarded();
        newerUnavailable();
      }

      expect(service.pendingInstances().has('inst-1')).toBe(false);
      expect(service.skippedInstances().has('inst-1')).toBe(true);
    },
  );

  it('ignores duplicate terminal and start events after an unavailable review settles', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-1' });
    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-1' });
    expect(service.skippedInstances().has('inst-1')).toBe(true);

    ipc.api.onDiscarded?.({
      instanceId: 'inst-1',
      reviewId: 'review-1',
      reason: 'superseded',
    });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-1' });

    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(true);
  });

  it('does not let duplicate result events overwrite a settled visible review', () => {
    const original: AggregatedReview = {
      id: 'review-1',
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      timestamp: 1,
    };
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-1' });
    ipc.api.onResult?.(original);
    ipc.api.onResult?.({ ...original, timestamp: 99 });
    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-1' });

    expect(service.getReviewForInstance('inst-1')).toEqual(original);
    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(false);
  });

  it('does not let a replayed pending start redefine the latest overlapping review', () => {
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });

    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-b' });
    ipc.api.onDiscarded?.({
      instanceId: 'inst-1',
      reviewId: 'review-a',
      reason: 'superseded',
    });

    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(true);
  });

  it('clears a previous visible review when a genuinely new review starts', () => {
    const previous: AggregatedReview = {
      id: 'review-a',
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      timestamp: 1,
    };
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
    ipc.api.onResult?.(previous);
    expect(service.getReviewForInstance('inst-1')).toEqual(previous);

    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });
    expect(service.getReviewForInstance('inst-1')).toBeUndefined();
    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-b' });

    expect(service.getReviewForInstance('inst-1')).toBeUndefined();
    expect(service.skippedInstances().has('inst-1')).toBe(true);
  });

  it('accepts an unknown terminal after a renderer reload', () => {
    ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-after-reload' });

    expect(service.pendingInstances().has('inst-1')).toBe(false);
    expect(service.skippedInstances().has('inst-1')).toBe(true);
  });

  it.each([
    ['unavailable', true],
    ['discarded', false],
  ] as const)(
    'does not publish an older result when the latest overlapping review is %s',
    (latestOutcome, expectedSkipped) => {
      const olderResult: AggregatedReview = {
        id: 'review-a',
        instanceId: 'inst-1',
        outputType: 'code',
        reviewDepth: 'structured',
        reviews: [],
        hasDisagreement: false,
        timestamp: 1,
      };
      ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
      ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });
      ipc.api.onResult?.(olderResult);

      if (latestOutcome === 'unavailable') {
        ipc.api.onAllUnavailable?.({ instanceId: 'inst-1', reviewId: 'review-b' });
      } else {
        ipc.api.onDiscarded?.({
          instanceId: 'inst-1',
          reviewId: 'review-b',
          reason: 'superseded',
        });
      }

      expect(service.getReviewForInstance('inst-1')).toBeUndefined();
      expect(service.pendingInstances().has('inst-1')).toBe(false);
      expect(service.skippedInstances().has('inst-1')).toBe(expectedSkipped);
    },
  );

  it('does not let an older overlapping result overwrite the latest result', () => {
    const makeResult = (id: string, timestamp: number): AggregatedReview => ({
      id,
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      timestamp,
    });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-a' });
    ipc.api.onStarted?.({ instanceId: 'inst-1', reviewId: 'review-b' });
    ipc.api.onResult?.(makeResult('review-b', 2));
    ipc.api.onResult?.(makeResult('review-a', 1));

    expect(service.getReviewForInstance('inst-1')).toEqual(makeResult('review-b', 2));
    expect(service.pendingInstances().has('inst-1')).toBe(false);
  });

  it('does not let a pre-reload stale result overwrite a newer observed result', () => {
    const makeResult = (
      id: string,
      reviewStartedAt: number,
      timestamp: number,
    ): AggregatedReview => ({
      id,
      instanceId: 'inst-1',
      outputType: 'code',
      reviewDepth: 'structured',
      reviews: [],
      hasDisagreement: false,
      reviewStartedAt,
      timestamp,
    });

    ipc.api.onStarted?.({
      instanceId: 'inst-1',
      reviewId: 'review-b',
      reviewStartedAt: 200,
    });
    ipc.api.onResult?.(makeResult('review-b', 200, 2));
    ipc.api.onResult?.(makeResult('review-a', 100, 3));

    expect(service.getReviewForInstance('inst-1')).toEqual(makeResult('review-b', 200, 2));
    expect(service.skippedInstances().has('inst-1')).toBe(false);
  });
});
