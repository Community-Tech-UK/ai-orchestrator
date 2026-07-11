import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CrossModelReviewIpcService } from './cross-model-review-ipc.service';
import { ElectronIpcService } from './electron-ipc.service';
import type { CrossModelReviewStatus } from '../../../../../shared/types/cross-model-review.types';

type Cb<T> = (data: T) => void;

/** Captures the event callbacks the service registers so tests can fire them. */
class FakeApi {
  onReviewerUnavailable?: Cb<{ dropped: { cli: string; error?: string }[] }>;
  onReviewerRateLimited?: Cb<{ instanceId?: string; cliType: string }>;
  onReviewerRateLimitCleared?: Cb<{ cliType: string }>;

  crossModelReviewOnStarted = (cb: Cb<unknown>): void => { void cb; };
  crossModelReviewOnResult = (cb: Cb<unknown>): void => { void cb; };
  crossModelReviewOnAllUnavailable = (cb: Cb<unknown>): void => { void cb; };
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
});
