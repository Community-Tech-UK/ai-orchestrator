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

@Component({
  selector: 'app-needs-you-request-row', standalone: true, imports: [LoopQuestionRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loopItem(); as item) {
      <app-loop-question-row [item]="item" [busy]="busy()" (answerRequested)="answer($event)" />
    } @else {
      <article class="request-row">
        <strong>{{ entry().title }}</strong>
        @if (entry().detail) { <p>{{ entry().detail }}</p> }
        @if (expiry()) { <span>{{ expiry() }}</span> }
        <button type="button" [attr.aria-label]="'Open ' + entry().title" (click)="open()">Open</button>
        @if (entry().kind === 'check') { <button type="button" (click)="store.markSeen(entry().key)">Got it</button> }
      </article>
    }
    @if (error()) { <p role="alert">{{ error() }}</p> }
  `,
  styles: [`.request-row { padding:12px; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); background:var(--bg-secondary); font-size:12px; } p { margin:6px 0; overflow-wrap:anywhere; } button { margin:6px 6px 0 0; cursor:pointer; } span { display:block; color:var(--text-secondary); }`],
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
