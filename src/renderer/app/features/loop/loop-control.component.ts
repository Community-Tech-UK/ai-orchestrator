import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LoopStore } from '../../core/state/loop.store';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { LoopConfigModalComponent } from './loop-config-modal.component';

/**
 * Composite Loop Mode UI:
 *   - footer toggle button (start/stop/pause)
 *   - inline status bar (visible while a loop is active)
 *   - no-progress / verify-failed banner
 *   - final summary card (after a loop ends)
 *
 * One component to drop into the chat composer footer. Wire `chatId` and
 * `workspaceCwd` from the host (chat-detail component).
 */
@Component({
  selector: 'app-loop-control',
  standalone: true,
  imports: [LoopConfigModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (banner(); as b) {
      <div class="loop-banner" [class.warn]="b.kind === 'no-progress'" [class.danger]="b.kind === 'claimed-failed'">
        @switch (b.kind) {
          @case ('no-progress') {
            <span class="loop-banner-title">Loop paused — no progress</span>
            <span class="loop-banner-msg">{{ b.message }} <code>(signal {{ b.signalId }})</code></span>
            <span class="loop-banner-actions">
              <button type="button" (click)="onInjectHint()">Inject hint</button>
              <button type="button" (click)="onResumeAnyway()">Resume anyway</button>
              <button type="button" (click)="onStop()">Stop</button>
            </span>
          }
          @case ('claimed-failed') {
            <span class="loop-banner-title">Verify failed</span>
            <span class="loop-banner-msg">Loop reported done via <code>{{ b.signal }}</code> but verify failed: {{ b.failure | slice:0:280 }}…</span>
            <span class="loop-banner-actions">
              <button type="button" (click)="onInjectHint()">Inject hint</button>
              <button type="button" (click)="onDismissBanner()">Dismiss</button>
            </span>
          }
        }
      </div>
    }

    @if (active(); as a) {
      <div class="loop-status" [class.paused]="a.status === 'paused'">
        <span class="ls-icon">{{ a.status === 'paused' ? '⏸' : '🔁' }}</span>
        <span class="ls-text">
          Loop · iter {{ a.totalIterations }}/{{ a.config.caps.maxIterations }}
          · stage {{ a.currentStage }}
          · {{ humanDuration(elapsed()) }}
          · {{ humanTokens(a.totalTokens) }}
          · &dollar;{{ (a.totalCostCents / 100).toFixed(2) }}
        </span>
        <span class="ls-actions">
          @if (a.status === 'running') {
            <button type="button" (click)="onPause()" title="Pause loop">Pause</button>
          } @else if (a.status === 'paused') {
            <button type="button" (click)="onResumeAnyway()" title="Resume loop">Resume</button>
          }
          <button type="button" (click)="onInjectHint()" title="Inject a hint into next iteration">Hint</button>
          <button type="button" class="ls-stop" (click)="onStop()" title="Stop loop">Stop</button>
        </span>
      </div>
    }

    @if (summary(); as s) {
      <div class="loop-summary">
        <div class="lsum-title">
          Loop ended — {{ statusLabel(s.status) }}
          <button type="button" class="lsum-close" (click)="store.dismissSummary(chatId())" aria-label="Dismiss">×</button>
        </div>
        <div class="lsum-line">
          {{ s.iterations }} iterations · {{ humanDuration(s.endedAt - s.startedAt) }} · {{ humanTokens(s.tokens) }} · &dollar;{{ (s.costCents / 100).toFixed(2) }}
        </div>
        <div class="lsum-reason">Reason: {{ s.reason }}</div>
      </div>
    }

    @if (!active() && !summary()) {
      <button
        type="button"
        class="loop-toggle"
        [class.active]="false"
        (click)="onClickToggle()"
        [disabled]="!chatId() || !workspaceCwd()"
        [title]="!chatId() || !workspaceCwd() ? 'Save the chat to enable Loop Mode' : 'Start an autonomous fix→verify loop'"
      >
        <span class="lt-icon">🔁</span>
        <span class="lt-label">Loop OFF</span>
      </button>
    }

    @if (showConfig()) {
      <app-loop-config-modal
        [workspaceCwd]="workspaceCwd() || ''"
        [initialPromptHint]="initialPromptHint()"
        (dismissed)="showConfig.set(false)"
        (confirm)="onConfirmStart($event)"
      />
    }
  `,
  styles: [`
    .loop-toggle {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px; font: inherit; font-size: 12px;
      background: rgba(255,255,255,0.04); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
      cursor: pointer;
    }
    .loop-toggle:hover { background: rgba(255,255,255,0.08); }
    .loop-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
    .loop-toggle.active { background: rgba(95,142,224,0.2); border-color: #5f8ee0; }

    .loop-status {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 6px 10px; margin: 6px 0;
      border: 1px solid rgba(95,142,224,0.45); background: rgba(95,142,224,0.1);
      border-radius: 6px; font-size: 12px;
    }
    .loop-status.paused { border-color: rgba(247,192,122,0.6); background: rgba(247,192,122,0.08); }
    .ls-text { flex: 1; }
    .ls-actions { display: flex; gap: 4px; }
    .ls-actions button {
      padding: 3px 8px; font-size: 11px; font: inherit;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
      cursor: pointer;
    }
    .ls-stop { color: #f78c7c !important; }

    .loop-banner {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
      padding: 8px 10px; margin: 6px 0;
      border-radius: 6px; font-size: 12px;
      border: 1px solid; line-height: 1.4;
    }
    .loop-banner.warn { background: rgba(247,192,122,0.12); border-color: rgba(247,192,122,0.45); }
    .loop-banner.danger { background: rgba(247,124,124,0.12); border-color: rgba(247,124,124,0.45); }
    .loop-banner-title { font-weight: 600; }
    .loop-banner-msg { flex: 1; }
    .loop-banner-actions { display: flex; gap: 4px; }
    .loop-banner-actions button {
      padding: 3px 8px; font-size: 11px;
      background: rgba(255,255,255,0.06); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
      cursor: pointer;
    }

    .loop-summary {
      padding: 8px 10px; margin: 6px 0;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
      background: rgba(255,255,255,0.04); font-size: 12px;
    }
    .lsum-title { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .lsum-close { background: none; border: none; color: inherit; cursor: pointer; font-size: 14px; padding: 0; }
    .lsum-line { margin-top: 4px; opacity: 0.85; }
    .lsum-reason { margin-top: 2px; opacity: 0.65; font-size: 11px; }
    code { font-size: 11px; padding: 1px 4px; background: rgba(255,255,255,0.08); border-radius: 3px; }
  `],
})
export class LoopControlComponent {
  // Inputs
  chatId = input<string | null>(null);
  workspaceCwd = input<string | null>(null);
  initialPromptHint = input<string>('');

  protected store = inject(LoopStore);

  // tick driver — re-render the elapsed time once per second
  private tick = signal(0);

  active = computed(() => {
    const id = this.chatId();
    return id ? this.store.activeForChat(id)() : undefined;
  });

  banner = computed(() => {
    const id = this.chatId();
    return id ? this.store.bannerForChat(id)() : null;
  });

  summary = computed(() => {
    const id = this.chatId();
    return id ? this.store.summaryForChat(id)() : null;
  });

  showConfig = signal(false);

  elapsed = computed(() => {
    this.tick(); // re-read on tick
    const a = this.active();
    if (!a) return 0;
    return Date.now() - a.startedAt;
  });

  constructor() {
    this.store.ensureWired();
    setInterval(() => this.tick.update((t) => t + 1), 1000);
  }

  // ────── handlers ──────

  onClickToggle(): void {
    if (this.active()) return;
    this.showConfig.set(true);
  }

  async onConfirmStart(config: LoopStartConfigInput): Promise<void> {
    const id = this.chatId();
    if (!id) return;
    this.showConfig.set(false);
    const r = await this.store.start(id, config);
    if (!r.ok) {
      // Surface error as a banner via the store. Cheap to rebuild.
      // The store doesn't expose a public setBanner, but the IPC error
      // event will already have fired if this came back from the main process.
      // For pre-flight failures, log to console — quick manual check.
      console.error('Loop start failed:', r.error);
    }
  }

  async onPause(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.pause(a.id);
  }

  async onResumeAnyway(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.resume(a.id);
  }

  async onStop(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.cancel(a.id);
  }

  async onInjectHint(): Promise<void> {
    const a = this.active(); if (!a) return;
    const message = window.prompt('Inject a hint for the next iteration:');
    if (!message?.trim()) return;
    await this.store.intervene(a.id, message.trim());
  }

  onDismissBanner(): void {
    const id = this.chatId();
    if (id) this.store.dismissBanner(id);
  }

  // ────── formatters ──────

  humanDuration(ms: number): string {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m${Math.floor((ms % 60_000) / 1000)}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h${mins % 60}m`;
  }

  humanTokens(n: number): string {
    if (n < 1000) return `${n} tok`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
    return `${(n / 1_000_000).toFixed(2)}M tok`;
  }

  statusLabel(status: 'completed' | 'cancelled' | 'cap-reached' | 'error' | 'no-progress'): string {
    switch (status) {
      case 'completed': return 'completed ✓';
      case 'cancelled': return 'cancelled';
      case 'cap-reached': return 'cap reached';
      case 'error': return 'error';
      case 'no-progress': return 'no progress';
    }
  }
}
