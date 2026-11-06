import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import type { QuickAskResultPayload } from '../../../../preload/domains/quick-ask.preload';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
import type { ContextUsage } from '../../../../shared/types/instance.types';

interface QuickAskView { state: 'asking' | 'answer' | 'failed'; text: string; notice?: string }

@Component({
  selector: 'app-quick-ask-panel',
  standalone: true,
  imports: [AppIconButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="quick-ask" aria-label="Quick ask">
      <div class="quick-ask-row">
        <input #questionBox type="text" aria-label="Question for this session" placeholder="Ask this session a question"
          [value]="question()" [disabled]="view()?.state === 'asking'"
          (input)="question.set(questionBox.value)" (keydown.enter)="onAsk()" (keydown.escape)="closed.emit()" />
        <button type="button" [disabled]="!canAsk()" (click)="onAsk()">Ask</button>
        <button type="button" appIconButton="Close quick ask" (click)="closed.emit()">✕</button>
      </div>
      @if (tokensLine(); as line) { <div class="quick-ask-meta">{{ line }}</div> }
      @if (view(); as result) {
        @if (result.state === 'asking') { <div class="quick-ask-meta" role="status">Asking…</div> }
        @else if (result.state === 'answer') {
          <div class="quick-ask-result" role="status"><span>{{ result.text }}</span>
            <button type="button" (click)="onCopy(result.text)">Copy</button></div>
          @if (result.notice; as notice) { <div class="quick-ask-meta quick-ask-notice">{{ notice }}</div> }
        } @else { <div class="quick-ask-failed" role="alert">{{ result.text }}</div> }
      }
      <p class="quick-ask-note">Quick ask answers from this session's conversation only. It cannot read files or run commands, it does not interrupt the work in progress, and it is not saved to the conversation.</p>
    </section>
  `,
  styles: [`
    .quick-ask { display: grid; gap: 8px; margin-bottom: 8px; padding: 10px 12px; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; background: rgba(255,255,255,.04); font: 11px var(--font-mono); }
    .quick-ask-row, .quick-ask-result { display: flex; gap: 8px; align-items: flex-start; }
    input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; background: transparent; color: inherit; }
    button { border: 1px solid rgba(255,255,255,.18); border-radius: 8px; padding: 5px 10px; background: transparent; color: inherit; cursor: pointer; }
    button:disabled { opacity: .5; cursor: default; }
    .quick-ask-result { white-space: pre-wrap; padding: 8px 10px; background: rgba(255,255,255,.05); border-radius: 8px; }
    .quick-ask-result span { flex: 1; }
    .quick-ask-meta, .quick-ask-note { color: var(--text-muted); }
    .quick-ask-note { margin: 0; line-height: 1.5; }
    .quick-ask-failed { color: var(--error-color, #ef4444); }
  `],
})
export class QuickAskPanelComponent {
  readonly instanceId = input.required<string>();
  readonly contextUsage = input<ContextUsage | null>(null);
  readonly closed = output<void>();
  private readonly ipc = inject(InstanceIpcService);
  readonly question = signal('');
  readonly view = signal<QuickAskView | null>(null);
  readonly canAsk = computed(() => {
    const length = this.question().trim().length;
    return length > 0 && length <= 4_000 && this.view()?.state !== 'asking';
  });
  readonly tokensLine = computed(() => {
    const usage = this.contextUsage();
    return usage?.occupancyReported && !usage.occupancyIsAggregate && Number.isFinite(usage.used) && usage.used >= 1_000
      ? `This asks the running session only, re-reading about ${Math.round(usage.used / 1_000)}K tokens.`
      : 'This asks the running session only and re-reads its conversation.';
  });

  async onAsk(): Promise<void> {
    if (!this.canAsk()) return;
    this.view.set({ state: 'asking', text: '' });
    try {
      const response = await this.ipc.quickAsk(this.instanceId(), this.question().trim());
      const result: QuickAskResultPayload | undefined = response.data;
      this.view.set(response.success && result?.ok && result.answer
        ? { state: 'answer', text: result.answer, ...(result.notice ? { notice: result.notice } : {}) }
        : { state: 'failed', text: result?.message ?? response.error?.message ?? 'No answer came back from this session.' });
    } catch (error) {
      this.view.set({ state: 'failed', text: error instanceof Error ? error.message : 'Quick ask failed.' });
    }
  }

  onCopy(text: string): void { void navigator.clipboard?.writeText(text); }
}
