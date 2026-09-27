import { Injectable, inject, signal } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type {
  MobileDocReviewDecisionRequest,
  MobileDocReviewDetailDto,
  MobileDocReviewSummaryDto,
} from '../../core/models';

@Injectable({ providedIn: 'root' })
export class DocReviewStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  readonly reviews = signal<MobileDocReviewSummaryDto[]>([]);
  readonly detail = signal<MobileDocReviewDetailDto | null>(null);
  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<string | null>(null);
  readonly pending = signal(false);

  async refresh(): Promise<void> {
    if (!this.hosts.activeHost() || !this.gateway.online()) {
      this.status.set(this.reviews().length ? 'ready' : 'idle');
      return;
    }
    this.status.set(this.reviews().length ? 'ready' : 'loading');
    try {
      this.reviews.set(await this.gateway.docReviews());
      this.status.set('ready');
      this.error.set(null);
    } catch (error) {
      this.status.set('error');
      this.error.set(error instanceof Error ? error.message : 'Reviews could not be loaded');
    }
  }

  async open(id: string): Promise<void> {
    this.detail.set(null);
    try {
      this.detail.set(await this.gateway.docReview(id));
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Review could not be loaded');
    }
  }

  async submit(id: string, body: MobileDocReviewDecisionRequest): Promise<boolean> {
    this.pending.set(true);
    this.error.set(null);
    try {
      await this.gateway.submitDocReview(id, body);
      await this.refresh();
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Review could not be submitted');
      return false;
    } finally {
      this.pending.set(false);
    }
  }
}
