import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DocReviewIpcService } from '../../core/services/ipc/doc-review-ipc.service';
import { DocReviewStore } from './doc-review.store';
import { DocReviewViewerComponent } from './doc-review-viewer.component';
import {
  DocReviewDecisionBarComponent,
} from './doc-review-decision-bar.component';
import { toItemDecisions } from './doc-review.types';
import type {
  DocReviewCommentMessage,
  DocReviewDecisionMessage,
} from './doc-review-viewer.component';
import type {
  DocReviewItemInfo,
  DocReviewItemState,
  DocReviewOverall,
  DocReviewSession,
} from './doc-review.types';

/**
 * Doc-review pane: a list of pending/decided reviews on the left, and the selected
 * review's sandboxed artifact plus decision chrome on the right. James toggles per-item
 * verdicts inside the artifact; the mirror and overall verdict live in Angular. On submit,
 * the canonical feedback block is pushed back into the requesting instance.
 */
@Component({
  selector: 'app-doc-review-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DocReviewViewerComponent, DocReviewDecisionBarComponent],
  template: `
    <div class="page">
      <aside class="list">
        <header><h2>Doc Reviews</h2></header>
        @if (store.error(); as err) {
          <div class="banner error" role="alert">
            {{ err }}
            <button type="button" (click)="store.clearError()">Dismiss</button>
          </div>
        }
        @if (pending().length === 0 && decided().length === 0) {
          <p class="empty">No reviews yet. Agents send plans and specs here with the <code>request_doc_review</code> tool.</p>
        }
        @if (pending().length > 0) {
          <h3>Pending</h3>
          @for (session of pending(); track session.id) {
            <button
              type="button"
              class="review-item"
              [class.selected]="session.id === store.selectedId()"
              (click)="store.select(session.id)"
            >
              <span class="review-title">{{ session.title }}</span>
              <span class="review-meta">{{ formatTime(session.createdAt) }}</span>
            </button>
          }
        }
        @if (decided().length > 0) {
          <h3>Decided</h3>
          @for (session of decided(); track session.id) {
            <button
              type="button"
              class="review-item decided"
              [class.selected]="session.id === store.selectedId()"
              (click)="store.select(session.id)"
            >
              <span class="review-title">{{ session.title }}</span>
              <span class="pill" [class]="statusPill(session)">{{ statusLabel(session) }}</span>
            </button>
          }
        }
      </aside>

      <section class="detail">
        @if (store.selected(); as session) {
          <header class="detail-header">
            <div>
              <h2>{{ session.title }}</h2>
              @if (session.sourcePath) {
                <code class="source">{{ session.sourcePath }}</code>
              }
            </div>
            <div class="actions">
              <button type="button" (click)="store.openExternal(session.id)">Open in browser</button>
              @if (session.status === 'pending') {
                <button type="button" class="danger" (click)="store.dismiss(session.id)">Dismiss</button>
              }
            </div>
          </header>

          @if (artifactError()) {
            <div class="banner error" role="alert">{{ artifactError() }}</div>
          } @else if (artifactHtml(); as html) {
            <div class="viewer">
              <app-doc-review-viewer
                [html]="html"
                (ready)="onReady($event)"
                (decisionChanged)="onDecision($event)"
                (commentChanged)="onComment($event)"
              />
            </div>
            @if (session.status === 'pending') {
              <app-doc-review-decision-bar
                [items]="itemStates()"
                [overall]="overall()"
                [general]="general()"
                [busy]="store.busy()"
                (overallChange)="overall.set($event)"
                (generalChange)="general.set($event)"
                (submitted)="onSubmit(session)"
              />
            } @else {
              <p class="decided-note">Decided {{ session.decidedAt ? formatTime(session.decidedAt) : '' }} — {{ statusLabel(session) }}.</p>
            }
          } @else {
            <p class="empty">Loading artifact…</p>
          }
        } @else {
          <p class="empty">Select a review to see its document.</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      :host { display: block; height: 100%; }
      .page { display: grid; grid-template-columns: 280px 1fr; gap: 16px; height: 100%; padding: 16px; box-sizing: border-box; }
      .list { display: flex; flex-direction: column; gap: 8px; overflow: auto; }
      .list h2 { font-size: 18px; margin: 0 0 8px; }
      .list h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 12px 0 4px; }
      .review-item {
        display: flex; flex-direction: column; gap: 4px; text-align: left;
        border: 1px solid var(--border-color); border-radius: var(--radius-md);
        background: var(--card-bg); color: var(--text-primary);
        padding: 10px 12px; cursor: pointer; transition: border-color var(--transition-fast);
      }
      .review-item:hover { border-color: var(--primary-color); }
      .review-item.selected { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color) inset; }
      .review-title { font-weight: 600; font-size: 14px; }
      .review-meta { color: var(--text-muted); font-size: 12px; }
      .detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .detail-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .detail-header h2 { margin: 0; font-size: 18px; }
      .source { color: var(--text-muted); font-size: 12px; }
      .actions { display: flex; gap: 8px; }
      .actions button, .banner button {
        appearance: none; border: 1px solid var(--border-color); border-radius: 8px;
        background: var(--bg-secondary); color: var(--text-primary);
        padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer;
      }
      .actions button.danger, .banner.error button { border-color: var(--error-border); color: var(--error-color); }
      .viewer { flex: 1 1 auto; min-height: 320px; display: flex; }
      .viewer app-doc-review-viewer { flex: 1 1 auto; }
      .pill { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
      .pill.ok { background: var(--pill-ok-bg); color: var(--pill-ok-fg); }
      .pill.warn { background: var(--pill-warn-bg); color: var(--pill-warn-fg); }
      .pill.error { background: var(--pill-error-bg); color: var(--pill-error-fg); }
      .banner { padding: 8px 12px; border-radius: var(--radius-md); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .banner.error { background: var(--error-bg); color: var(--error-color); border: 1px solid var(--error-border); }
      .empty, .decided-note { color: var(--text-muted); font-size: 13px; }
    `,
  ],
})
export class DocReviewPageComponent {
  readonly store = inject(DocReviewStore);
  private readonly ipc = inject(DocReviewIpcService);

  readonly pending = this.store.pending;
  readonly decided = this.store.decided;

  readonly artifactHtml = signal<string | null>(null);
  readonly artifactError = signal<string | null>(null);
  readonly itemStates = signal<DocReviewItemState[]>([]);
  readonly overall = signal<DocReviewOverall | null>(null);
  readonly general = signal('');

  /** Monotonic token so a slow artifact load for a stale selection is ignored. */
  private loadToken = 0;

  private readonly selectedIdForEffect = computed(() => this.store.selected()?.id ?? null);

  constructor() {
    effect(() => {
      const id = this.selectedIdForEffect();
      this.resetDecisionState();
      if (id) void this.loadArtifact(id);
      else this.artifactHtml.set(null);
    });
  }

  onReady(items: DocReviewItemInfo[]): void {
    this.itemStates.set(items.map((info) => ({ info, decision: null, comment: '' })));
  }

  onDecision(message: DocReviewDecisionMessage): void {
    this.itemStates.update((states) =>
      states.map((s) => (s.info.id === message.itemId ? { ...s, decision: message.decision } : s)),
    );
  }

  onComment(message: DocReviewCommentMessage): void {
    this.itemStates.update((states) =>
      states.map((s) => (s.info.id === message.itemId ? { ...s, comment: message.comment } : s)),
    );
  }

  async onSubmit(session: DocReviewSession): Promise<void> {
    const overall = this.overall();
    if (!overall) return;
    await this.store.submit(session.id, overall, toItemDecisions(this.itemStates()), this.general() || undefined);
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  statusLabel(session: DocReviewSession): string {
    switch (session.status) {
      case 'approved':
        return 'Approved';
      case 'changes_requested':
        return 'Changes requested';
      case 'rejected':
        return 'Rejected';
      default:
        return 'Pending';
    }
  }

  statusPill(session: DocReviewSession): string {
    switch (session.status) {
      case 'approved':
        return 'ok';
      case 'rejected':
        return 'error';
      default:
        return 'warn';
    }
  }

  private resetDecisionState(): void {
    this.itemStates.set([]);
    this.overall.set(null);
    this.general.set('');
    this.artifactError.set(null);
  }

  private async loadArtifact(reviewId: string): Promise<void> {
    const token = ++this.loadToken;
    this.artifactHtml.set(null);
    const response = await this.ipc.readArtifact(reviewId);
    if (token !== this.loadToken) return;
    if (!response.success || !response.data) {
      this.artifactError.set(response.error?.message ?? 'Failed to load artifact.');
      return;
    }
    this.artifactHtml.set(response.data.html);
  }
}
