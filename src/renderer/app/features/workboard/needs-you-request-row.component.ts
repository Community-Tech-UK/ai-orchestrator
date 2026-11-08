import { ChangeDetectionStrategy, Component, Injector, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { LoopAnswerOutstandingPayload } from '@contracts/schemas/loop';
import type { NeedsYouEntry } from '../../../../shared/attention/needs-you';
import { sideChatParentKey } from '../../../../shared/types/side-chat.types';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { SideChatStore } from '../../core/state/side-chat.store';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { LoopQuestionRowComponent } from '../loop/loop-question-row.component';
import { NeedsYouStore } from './needs-you.store';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { MemoryReviewStore } from '../memory-review/memory-review.store';

/** Only for requests whose title is a bare name; the others already say what they ask. */
const REQUEST_KIND_LABELS: Partial<Record<NeedsYouEntry['source'], string>> = {
  'permission-request': 'Permission request',
  'doc-review': 'Document waiting for your review',
  'memory-review': 'Memory waiting for your review',
  'sidechat': 'Sidechat',
};

@Component({
  selector: 'app-needs-you-request-row', standalone: true, imports: [LoopQuestionRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loopItem(); as item) {
      <app-loop-question-row [item]="item" [busy]="busy()" (answerRequested)="answer($event)" />
    } @else {
      <article class="request-row">
        @if (kindLabel(); as label) { <span class="request-kind">{{ label }}</span> }
        <strong class="request-title">{{ entry().title }}</strong>
        @if (entry().detail) { <p>{{ entry().detail }}</p> }
        @if (expiry()) { <span class="request-expiry">{{ expiry() }}</span> }
        <div class="request-actions">
          <button type="button" [attr.aria-label]="openLabel() + ' ' + entry().title" (click)="open()">{{ openLabel() }}</button>
          @if (entry().kind === 'check') { <button type="button" (click)="store.markSeen(entry().key)">Got it</button> }
        </div>
      </article>
    }
    @if (error()) { <p role="alert">{{ error() }}</p> }
  `,
  styles: [`
    .request-row { display:flex; flex-direction:column; gap:4px; padding:12px; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); background:var(--bg-secondary); font-size:12px; }
    .request-kind { color:var(--text-muted); font-size:11px; }
    .request-title { overflow-wrap:anywhere; }
    p { margin:0; color:var(--text-secondary); overflow-wrap:anywhere; }
    .request-expiry { color:var(--text-secondary); }
    .request-actions { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
    button { font-size:11px; font-weight:600; padding:3px 10px; border-radius:var(--radius-sm,6px); border:1px solid var(--border-color); background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; }
    button:hover { background:var(--bg-hover); }
    button:focus-visible { outline:2px solid var(--border-focus, var(--primary-color)); outline-offset:2px; }
  `],
})
export class NeedsYouRequestRowComponent {
  readonly entry = input.required<NeedsYouEntry>();
  readonly store = inject(NeedsYouStore);
  private readonly ipc = inject(LoopIpcService);
  private readonly navigator = inject(SessionNavigator);
  private readonly router = inject(Router);
  private readonly sidechats = inject(SideChatStore);
  private readonly clock = inject(PermissionApprovalsStore).now;
  private readonly injector = inject(Injector);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly loopItem = computed(() => ['loop-question', 'loop-decision'].includes(this.entry().source)
    ? this.store.outstanding().find((item) => `${this.entry().source}:${item.id}` === this.entry().key) ?? null : null);
  /** What kind of request this is, so a bare document title still says what is being asked. */
  readonly kindLabel = computed(() => REQUEST_KIND_LABELS[this.entry().source] ?? null);
  readonly openLabel = computed(() => ['doc-review', 'memory-review'].includes(this.entry().source) ? 'Review' : 'Open');
  readonly expiry = computed(() => {
    const deadline = this.entry().deadlineAt;
    return deadline ? `Expires in ${Math.max(0, Math.ceil((deadline - this.clock()) / 60_000))} min` : '';
  });
  open(): void {
    const entry = this.entry();
    if (entry.kind === 'check') this.store.markSeen(entry.key);
    if (entry.source === 'doc-review') this.injector.get(DocReviewStore).select(entry.key.slice('doc-review:'.length));
    if (entry.source === 'memory-review') void this.injector.get(MemoryReviewStore).select(entry.key.slice('memory-review:'.length));
    if (entry.source === 'sidechat') {
      const target = this.sidechats.attentionList().find((item) => `sidechat:${sideChatParentKey(item.parent)}` === entry.key);
      if (target) this.sidechats.requestOpen(target.parent, target.targetChatId);
      void this.router.navigateByUrl('/');
    } else if (entry.instanceId) this.navigator.openSession(entry.instanceId);
    else if (entry.route) void this.router.navigateByUrl(entry.route);
  }
  async answer(payload: LoopAnswerOutstandingPayload): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const result = await this.ipc.answerOutstanding(payload);
      if (!result.success || !result.data?.ok) this.error.set('Could not save your answer.');
      else await this.store.refreshOutstanding();
    } catch { this.error.set('Could not save your answer.'); }
    finally { this.busy.set(false); }
  }
}
