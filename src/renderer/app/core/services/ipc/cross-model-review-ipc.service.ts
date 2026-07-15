/**
 * Cross-Model Review IPC Service
 *
 * Manages communication with the main process for cross-model review events.
 * Exposes signals for reactive state consumption in components.
 */

import { Injectable, signal, NgZone, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type {
  AggregatedReview,
  CrossModelReviewStatus,
  ReviewActionPayload,
  ReviewDismissPayload,
} from '../../../../../shared/types/cross-model-review.types';

const MAX_TRACKED_SETTLED_REVIEWS_PER_INSTANCE = 100;

/** A reviewer that dropped out of the pool: not detected, or rate/quota capped. */
export type ReviewerNoticeKind = 'unavailable' | 'rate-limited';

export interface ReviewerNotice {
  cliType: string;
  kind: ReviewerNoticeKind;
  at: number;
  /** Populated for rate-limit notices (the review that hit the cap). */
  instanceId?: string;
  /** Populated for unavailable notices (detection error, when known). */
  reason?: string;
}

/** Typed extension for the cross-model review APIs exposed by the preload */
interface CrossModelReviewApi {
  crossModelReviewOnStarted?: (
    callback: (data: { instanceId: string; reviewId: string; reviewStartedAt?: number }) => void,
  ) => void;
  crossModelReviewOnResult?: (callback: (data: AggregatedReview) => void) => void;
  crossModelReviewOnDiscarded?: (
    callback: (data: { instanceId: string; reviewId: string; reviewStartedAt?: number; reason: 'superseded' }) => void,
  ) => void;
  crossModelReviewOnAllUnavailable?: (
    callback: (data: { instanceId: string; reviewId: string; reviewStartedAt?: number }) => void,
  ) => void;
  crossModelReviewOnReviewerUnavailable?: (
    callback: (data: { dropped: { cli: string; error?: string }[] }) => void,
  ) => void;
  crossModelReviewOnReviewerRateLimited?: (
    callback: (data: { instanceId?: string; cliType: string }) => void,
  ) => void;
  crossModelReviewOnReviewerRateLimitCleared?: (
    callback: (data: { cliType: string }) => void,
  ) => void;
  crossModelReviewStatus?: () => Promise<CrossModelReviewStatus>;
  crossModelReviewDismiss?: (payload: ReviewDismissPayload) => Promise<void>;
  crossModelReviewAction?: (payload: ReviewActionPayload) => Promise<unknown>;
}

@Injectable({ providedIn: 'root' })
export class CrossModelReviewIpcService {
  private zone = inject(NgZone);
  private ipc = inject(ElectronIpcService);
  private pendingReviewIds = new Map<string, Set<string>>();
  private latestStartedReviews = new Map<string, { reviewId: string; startedAt: number }>();
  private unavailableReviewIds = new Map<string, Set<string>>();
  private settledReviewIds = new Map<string, Set<string>>();

  readonly latestReview = signal(new Map<string, AggregatedReview>());
  readonly status = signal<CrossModelReviewStatus | null>(null);
  readonly pendingInstances = signal(new Set<string>());
  readonly skippedInstances = signal(new Set<string>());
  /** Latest health notice per reviewer CLI (unavailable / rate-limited). */
  readonly reviewerNotices = signal(new Map<string, ReviewerNotice>());

  constructor() {
    this.listenForResults();
    void this.refreshStatus();
  }

  private get api(): CrossModelReviewApi | null {
    return this.ipc.getApi() as unknown as CrossModelReviewApi | null;
  }

  private listenForResults(): void {
    const api = this.api;
    if (!api) return;

    api.crossModelReviewOnStarted?.((data) => {
      this.zone.run(() => {
        if (!this.addPendingReview(data.instanceId, data.reviewId, data.reviewStartedAt)) return;

        const reviews = new Map(this.latestReview());
        reviews.delete(data.instanceId);
        this.latestReview.set(reviews);

        const skipped = new Set(this.skippedInstances());
        skipped.delete(data.instanceId);
        this.skippedInstances.set(skipped);
      });
    });

    api.crossModelReviewOnResult?.((data) => {
      this.zone.run(() => {
        if (!this.settleReview(data.instanceId, data.id, 'result', data.reviewStartedAt)) return;
        if (this.latestStartedReviews.get(data.instanceId)?.reviewId !== data.id) return;

        const map = new Map(this.latestReview());
        map.set(data.instanceId, data);
        this.latestReview.set(map);
      });
    });

    api.crossModelReviewOnDiscarded?.((data) => {
      this.zone.run(() => {
        this.settleReview(
          data.instanceId,
          data.reviewId,
          'discarded',
          data.reviewStartedAt,
        );
      });
    });

    api.crossModelReviewOnAllUnavailable?.((data) => {
      this.zone.run(() => {
        this.settleReview(
          data.instanceId,
          data.reviewId,
          'unavailable',
          data.reviewStartedAt,
        );
      });
    });

    api.crossModelReviewOnReviewerUnavailable?.((data) => {
      this.zone.run(() => {
        // This event carries the *current* full unavailable set, so replace all
        // 'unavailable' notices (dropping ones that have since recovered) while
        // preserving 'rate-limited' notices, which have their own lifecycle.
        const notices = new Map(this.reviewerNotices());
        for (const [cli, notice] of [...notices]) {
          if (notice.kind === 'unavailable') notices.delete(cli);
        }
        for (const { cli, error } of data.dropped ?? []) {
          notices.set(cli, { cliType: cli, kind: 'unavailable', at: Date.now(), reason: error });
        }
        this.reviewerNotices.set(notices);
      });
    });

    api.crossModelReviewOnReviewerRateLimited?.((data) => {
      this.zone.run(() => {
        const notices = new Map(this.reviewerNotices());
        notices.set(data.cliType, {
          cliType: data.cliType,
          kind: 'rate-limited',
          at: Date.now(),
          instanceId: data.instanceId,
        });
        this.reviewerNotices.set(notices);
      });
    });

    api.crossModelReviewOnReviewerRateLimitCleared?.((data) => {
      this.zone.run(() => {
        const notices = new Map(this.reviewerNotices());
        // Only clear a rate-limit notice; don't wipe an unavailable one that may
        // have replaced it in the meantime.
        if (notices.get(data.cliType)?.kind === 'rate-limited' && notices.delete(data.cliType)) {
          this.reviewerNotices.set(notices);
        }
      });
    });
  }

  private addPendingReview(
    instanceId: string,
    reviewId: string,
    reviewStartedAt: number | undefined,
  ): boolean {
    if (this.settledReviewIds.get(instanceId)?.has(reviewId)) return false;

    const reviewIds = this.pendingReviewIds.get(instanceId) ?? new Set<string>();
    if (reviewIds.has(reviewId)) return false;
    if (reviewIds.size === 0) {
      this.unavailableReviewIds.delete(instanceId);
    }
    reviewIds.add(reviewId);
    this.pendingReviewIds.set(instanceId, reviewIds);
    this.observeReviewStart(instanceId, reviewId, reviewStartedAt);

    const pending = new Set(this.pendingInstances());
    pending.add(instanceId);
    this.pendingInstances.set(pending);
    return true;
  }

  private settleReview(
    instanceId: string,
    reviewId: string,
    outcome: 'result' | 'discarded' | 'unavailable',
    reviewStartedAt: number | undefined,
  ): boolean {
    if (this.settledReviewIds.get(instanceId)?.has(reviewId)) return false;
    this.rememberSettledReview(instanceId, reviewId);

    const reviewIds = this.pendingReviewIds.get(instanceId);
    const wasPending = reviewIds?.delete(reviewId) ?? false;
    if (!wasPending && (!reviewIds || reviewIds.size === 0)) {
      this.observeReviewStart(instanceId, reviewId, reviewStartedAt);
    }

    const unavailable = this.unavailableReviewIds.get(instanceId) ?? new Set<string>();
    if (outcome === 'unavailable') {
      unavailable.add(reviewId);
      this.unavailableReviewIds.set(instanceId, unavailable);
    } else {
      unavailable.delete(reviewId);
    }

    const pending = new Set(this.pendingInstances());
    const skipped = new Set(this.skippedInstances());
    if (reviewIds && reviewIds.size > 0) {
      pending.add(instanceId);
      skipped.delete(instanceId);
      this.pendingInstances.set(pending);
      this.skippedInstances.set(skipped);
      return true;
    }

    this.pendingReviewIds.delete(instanceId);
    pending.delete(instanceId);
    this.pendingInstances.set(pending);

    const latestReviewId = this.latestStartedReviews.get(instanceId)?.reviewId;
    if (latestReviewId && unavailable.has(latestReviewId)) {
      skipped.add(instanceId);
    } else {
      skipped.delete(instanceId);
    }
    this.skippedInstances.set(skipped);
    return true;
  }

  private observeReviewStart(
    instanceId: string,
    reviewId: string,
    reviewStartedAt: number | undefined,
  ): void {
    const startedAt = this.resolveReviewStartedAt(reviewId, reviewStartedAt);
    const current = this.latestStartedReviews.get(instanceId);
    if (!current || startedAt >= current.startedAt) {
      this.latestStartedReviews.set(instanceId, { reviewId, startedAt });
    }
  }

  private resolveReviewStartedAt(reviewId: string, reviewStartedAt: number | undefined): number {
    if (reviewStartedAt !== undefined && Number.isFinite(reviewStartedAt)) return reviewStartedAt;
    const encodedTimestamp = reviewId.match(/^review-(\d+)-/)?.[1];
    return encodedTimestamp ? Number(encodedTimestamp) : Date.now();
  }

  private rememberSettledReview(instanceId: string, reviewId: string): void {
    const settled = this.settledReviewIds.get(instanceId) ?? new Set<string>();
    settled.add(reviewId);
    while (settled.size > MAX_TRACKED_SETTLED_REVIEWS_PER_INSTANCE) {
      const oldest = settled.values().next().value;
      if (oldest === undefined) break;
      settled.delete(oldest);
    }
    this.settledReviewIds.set(instanceId, settled);
  }

  /** The current health notice for a reviewer CLI, if any. */
  getReviewerNotice(cliType: string): ReviewerNotice | undefined {
    return this.reviewerNotices().get(cliType);
  }

  /** Clear a reviewer's notice (e.g. after it recovers or the user dismisses). */
  clearReviewerNotice(cliType: string): void {
    const notices = new Map(this.reviewerNotices());
    if (notices.delete(cliType)) {
      this.reviewerNotices.set(notices);
    }
  }

  async refreshStatus(): Promise<void> {
    const api = this.api;
    if (!api?.crossModelReviewStatus) return;
    const status = await api.crossModelReviewStatus();
    this.zone.run(() => {
      this.status.set(status);
      this.hydrateNoticesFromStatus(status);
    });
  }

  /**
   * Rebuild reviewer notices from a status snapshot. Events are deduped/fire-
   * and-forget, so without this a persistently-unavailable reviewer (or any
   * notice after a renderer reload) would show no badge until the set next
   * changed. refreshStatus() runs on construction, so badges hydrate on load.
   */
  private hydrateNoticesFromStatus(status: CrossModelReviewStatus | null): void {
    if (!status) return;
    const notices = new Map<string, ReviewerNotice>();
    for (const u of status.unavailableReviewers ?? []) {
      notices.set(u.cli, { cliType: u.cli, kind: 'unavailable', at: Date.now(), reason: u.error });
    }
    for (const r of status.reviewers ?? []) {
      // Don't let a rate-limit notice mask an unavailable one for the same CLI.
      if (r.rateLimited && !notices.has(r.cliType)) {
        notices.set(r.cliType, { cliType: r.cliType, kind: 'rate-limited', at: Date.now() });
      }
    }
    this.reviewerNotices.set(notices);
  }

  async dismiss(payload: ReviewDismissPayload): Promise<void> {
    const api = this.api;
    if (!api?.crossModelReviewDismiss) return;
    await api.crossModelReviewDismiss(payload);
    const map = new Map(this.latestReview());
    map.delete(payload.instanceId);
    this.latestReview.set(map);

    const skipped = new Set(this.skippedInstances());
    skipped.delete(payload.instanceId);
    this.skippedInstances.set(skipped);
  }

  async performAction(payload: ReviewActionPayload): Promise<unknown> {
    const api = this.api;
    if (!api?.crossModelReviewAction) return undefined;
    return api.crossModelReviewAction(payload);
  }

  getReviewForInstance(instanceId: string): AggregatedReview | undefined {
    return this.latestReview().get(instanceId);
  }
}
