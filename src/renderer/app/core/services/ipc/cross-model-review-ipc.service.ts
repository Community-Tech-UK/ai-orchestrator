/**
 * Cross-Model Review IPC Service
 *
 * Manages communication with the main process for cross-model review events.
 * Exposes signals for reactive state consumption in components.
 */

import { Injectable, signal, NgZone, inject } from '@angular/core';
import type {
  AggregatedReview,
  CrossModelReviewStatus,
  ReviewActionPayload,
  ReviewDismissPayload,
} from '../../../../../shared/types/cross-model-review.types';

/** Typed extension for the cross-model review APIs exposed by the preload */
interface CrossModelReviewApi {
  crossModelReviewOnStarted?: (callback: (data: { instanceId: string; reviewId: string }) => void) => void;
  crossModelReviewOnResult?: (callback: (data: AggregatedReview) => void) => void;
  crossModelReviewOnAllUnavailable?: (callback: (data: { instanceId: string }) => void) => void;
  crossModelReviewStatus?: () => Promise<CrossModelReviewStatus>;
  crossModelReviewDismiss?: (payload: ReviewDismissPayload) => Promise<void>;
  crossModelReviewAction?: (payload: ReviewActionPayload) => Promise<unknown>;
}

function getCrossModelApi(): CrossModelReviewApi | null {
  if (typeof window === 'undefined' || !window.electronAPI) return null;
  return window.electronAPI as unknown as CrossModelReviewApi;
}

@Injectable({ providedIn: 'root' })
export class CrossModelReviewIpcService {
  private zone = inject(NgZone);

  readonly latestReview = signal(new Map<string, AggregatedReview>());
  readonly status = signal<CrossModelReviewStatus | null>(null);
  readonly pendingInstances = signal(new Set<string>());
  readonly skippedInstances = signal(new Set<string>());

  constructor() {
    this.listenForResults();
    void this.refreshStatus();
  }

  private listenForResults(): void {
    const api = getCrossModelApi();
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
  }

  async refreshStatus(): Promise<void> {
    const api = getCrossModelApi();
    if (!api?.crossModelReviewStatus) return;
    const status = await api.crossModelReviewStatus();
    this.zone.run(() => this.status.set(status));
  }

  async dismiss(payload: ReviewDismissPayload): Promise<void> {
    const api = getCrossModelApi();
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
    const api = getCrossModelApi();
    if (!api?.crossModelReviewAction) return undefined;
    return api.crossModelReviewAction(payload);
  }

  getReviewForInstance(instanceId: string): AggregatedReview | undefined {
    return this.latestReview().get(instanceId);
  }
}
