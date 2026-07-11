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
  crossModelReviewOnStarted?: (callback: (data: { instanceId: string; reviewId: string }) => void) => void;
  crossModelReviewOnResult?: (callback: (data: AggregatedReview) => void) => void;
  crossModelReviewOnAllUnavailable?: (callback: (data: { instanceId: string }) => void) => void;
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
        const pending = new Set(this.pendingInstances());
        pending.add(data.instanceId);
        this.pendingInstances.set(pending);

        const skipped = new Set(this.skippedInstances());
        skipped.delete(data.instanceId);
        this.skippedInstances.set(skipped);
      });
    });

    api.crossModelReviewOnResult?.((data) => {
      this.zone.run(() => {
        const map = new Map(this.latestReview());
        map.set(data.instanceId, data);
        this.latestReview.set(map);

        const pending = new Set(this.pendingInstances());
        pending.delete(data.instanceId);
        this.pendingInstances.set(pending);

        const skipped = new Set(this.skippedInstances());
        skipped.delete(data.instanceId);
        this.skippedInstances.set(skipped);
      });
    });

    api.crossModelReviewOnAllUnavailable?.((data) => {
      this.zone.run(() => {
        const pending = new Set(this.pendingInstances());
        pending.delete(data.instanceId);
        this.pendingInstances.set(pending);

        const skipped = new Set(this.skippedInstances());
        skipped.add(data.instanceId);
        this.skippedInstances.set(skipped);
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
