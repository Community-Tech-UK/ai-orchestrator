import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { DocReviewIpcService } from '../../core/services/ipc/doc-review-ipc.service';
import {
  DocReviewChangedEventSchema,
} from '@contracts/schemas/doc-review';
import type {
  DocReviewItemDecision,
  DocReviewOverall,
  DocReviewSession,
} from './doc-review.types';

/**
 * Signal store for the doc-review pane. Holds the review sessions surfaced by the main
 * process, tracks a pending count for the shell badge, and refreshes on the
 * DOC_REVIEW_CHANGED event. Writes go through James-driven UI only — never an agent.
 */
@Injectable({ providedIn: 'root' })
export class DocReviewStore implements OnDestroy {
  private readonly ipc = inject(DocReviewIpcService);
  private readonly unsubscribe: () => void;

  private readonly _sessions = signal<DocReviewSession[]>([]);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _selectedId = signal<string | null>(null);

  readonly sessions = this._sessions.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();

  readonly pending = computed(() => this._sessions().filter((s) => s.status === 'pending'));
  readonly decided = computed(() => this._sessions().filter((s) => s.status !== 'pending'));
  readonly pendingCount = computed(() => this.pending().length);
  readonly selected = computed(() => {
    const id = this._selectedId();
    return id ? this._sessions().find((s) => s.id === id) ?? null : null;
  });

  constructor() {
    this.unsubscribe = this.ipc.onChanged((event) => this.applyChange(event));
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.unsubscribe();
  }

  select(reviewId: string | null): void {
    this._selectedId.set(reviewId);
  }

  clearError(): void {
    this._error.set(null);
  }

  async refresh(): Promise<void> {
    const response = await this.ipc.list();
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to load reviews.');
      return;
    }
    this._sessions.set(response.data ?? []);
    this.ensureSelection();
  }

  async submit(
    reviewId: string,
    overall: DocReviewOverall,
    decisions: DocReviewItemDecision[],
    generalComment?: string,
  ): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.submitDecision({
        reviewId,
        overall,
        decisions,
        generalComment,
      });
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to submit decision.');
        return false;
      }
      if (response.data) this.upsert(response.data);
      return true;
    });
  }

  async dismiss(reviewId: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.dismiss(reviewId);
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to dismiss review.');
        return false;
      }
      this.removeLocal(reviewId);
      return true;
    });
  }

  async retryDelivery(reviewId: string): Promise<boolean> {
    return this.runBusy(async () => {
      const response = await this.ipc.retryDelivery(reviewId);
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to retry review delivery.');
        return false;
      }
      if (response.data) this.upsert(response.data);
      return true;
    });
  }

  async openExternal(reviewId: string): Promise<void> {
    const response = await this.ipc.openExternal(reviewId);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to open artifact.');
    }
  }

  private ensureSelection(): void {
    const current = this._selectedId();
    const sessions = this._sessions();
    if (current && sessions.some((s) => s.id === current)) return;
    const firstPending = sessions.find((s) => s.status === 'pending');
    this._selectedId.set(firstPending?.id ?? sessions[0]?.id ?? null);
  }

  private applyChange(event: unknown): void {
    const parsed = DocReviewChangedEventSchema.safeParse(event);
    if (!parsed.success) return;
    const { kind, reviewId, session } = parsed.data;
    if (kind === 'dismissed' || !session) {
      this.removeLocal(reviewId);
      return;
    }
    this.upsert(session);
  }

  private upsert(session: DocReviewSession): void {
    this._sessions.update((items) => {
      const index = items.findIndex((s) => s.id === session.id);
      if (index === -1) return [session, ...items];
      const next = [...items];
      next[index] = session;
      return next;
    });
    this.ensureSelection();
  }

  private removeLocal(reviewId: string): void {
    this._sessions.update((items) => items.filter((s) => s.id !== reviewId));
    if (this._selectedId() === reviewId) this._selectedId.set(null);
    this.ensureSelection();
  }

  private async runBusy<T>(fn: () => Promise<T>): Promise<T> {
    this._busy.set(true);
    this._error.set(null);
    try {
      return await fn();
    } finally {
      this._busy.set(false);
    }
  }
}
