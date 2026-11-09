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
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { TOOL_LOOP_CONTINUE_CONSEQUENCE } from '../../../../shared/tool-loop-summary';

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
        @if (entry().source === 'tool-loop') { <p>{{ continueConsequence }}</p> }
        @if (expiry()) { <span class="request-expiry">{{ expiry() }}</span> }
        <div class="request-actions">
          @if (entry().source === 'tool-loop') {
            <button type="button" [attr.aria-label]="(toolLoopStopping() ? 'Stopping' : 'Stop this turn') + ': ' + entry().title" [disabled]="toolLoopStopping()" (click)="stopToolLoop()">{{ toolLoopStopping() ? 'Stopping…' : 'Stop this turn' }}</button>
            <button type="button" [attr.aria-label]="'Let it continue: ' + entry().title" [disabled]="toolLoopStopping()" (click)="letToolLoopContinue()">Let it continue</button>
          }
          <button type="button" [attr.aria-label]="openLabel() + ' ' + entry().title" (click)="open()">{{ openLabel() }}</button>
          @if (entry().kind === 'check') { <button type="button" (click)="store.markSeen(entry().key)">Got it</button> }
        </div>
      </article>
    }
    @if (error() ?? toolLoopError(); as message) { <p role="alert">{{ message }}</p> }
  `,
  styles: [`
    .request-row { display:flex; flex-direction:column; gap:4px; padding:12px; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); background:var(--bg-secondary); font-size:12px; }
    .request-kind { color:var(--text-muted); font-size:11px; }
    .request-title { overflow-wrap:anywhere; }
    p { margin:0; color:var(--text-secondary); overflow-wrap:anywhere; }
    .request-expiry { color:var(--text-secondary); }
    .request-actions { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
    button { font-size:11px; font-weight:600; padding:3px 10px; border-radius:var(--radius-sm,6px); border:1px solid var(--border-color); background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer; }
    button:hover:not(:disabled) { background:var(--bg-hover); }
    button:disabled { cursor:default; opacity:0.6; }
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
  protected readonly continueConsequence = TOOL_LOOP_CONTINUE_CONSEQUENCE;
  /** Read from the store, so a stop started anywhere (the session bar, the notification centre) disables this too. */
  readonly toolLoopStopping = computed(() => this.entry().source === 'tool-loop'
    && this.injector.get(ToolLoopAlertStore).isStopping(this.entry().instanceId));
  readonly error = signal<string | null>(null);
  /** Tied to the detection it was about (entry version), so a newer one never shows an old failure. */
  private readonly toolLoopErrorState = signal<{ key: string; version: string } | null>(null);
  readonly toolLoopError = computed(() => {
    const state = this.toolLoopErrorState();
    const entry = this.entry();
    return state && state.key === entry.key && state.version === entry.version
      ? 'Could not stop this turn. Open the session and use Stop.' : null;
  });
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
  /** Same as Stop in the session; the entry leaves the list once the alert is cleared. */
  async stopToolLoop(): Promise<void> {
    const { instanceId, key, version } = this.entry();
    if (!instanceId) return;
    this.toolLoopErrorState.set(null);
    try {
      if (!await this.injector.get(ToolLoopAlertStore).stopTurn(instanceId)) this.toolLoopErrorState.set({ key, version });
    } catch { this.toolLoopErrorState.set({ key, version }); }
  }
  letToolLoopContinue(): void {
    const instanceId = this.entry().instanceId;
    this.toolLoopErrorState.set(null);
    if (instanceId) this.injector.get(ToolLoopAlertStore).letContinue(instanceId);
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
