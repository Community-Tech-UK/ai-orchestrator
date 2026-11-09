/**
 * The decision for a session that may be stuck repeating tool calls, offered in
 * the session itself, right above the message box and its Stop button.
 *
 * Before this the session list said the session needed a decision, but opening
 * the session showed nothing to decide with: the only buttons lived in the
 * notification centre. The alert itself comes from `ToolLoopAlertStore` and
 * clears on its own when the turn ends.
 *
 * A banner under docs/screen-and-wording-guide.md section 4 because it asks for
 * a decision about the turn that is running now: it belongs next to Stop, and a
 * transcript line would scroll out of view under a busy session, which is how
 * the decision got lost. Notices that can wait stay transcript lines.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { TOOL_LOOP_CONTINUE_CONSEQUENCE, describeToolLoop } from '../../../../shared/tool-loop-summary';

@Component({
  selector: 'app-tool-loop-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (alert()) {
      <div class="tool-loop-bar">
        <p class="tool-loop-text" role="status">
          <strong>This session may be stuck.</strong>
          {{ summary() }} {{ continueConsequence }}
        </p>
        <div class="tool-loop-actions">
          <button type="button" class="tool-loop-btn tool-loop-btn--primary" [disabled]="stopping()" (click)="stop()">
            {{ stopping() ? 'Stopping…' : 'Stop this turn' }}
          </button>
          <button type="button" class="tool-loop-btn" [disabled]="stopping()" (click)="letContinue()">Let it continue</button>
        </div>
        @if (error()) { <p class="tool-loop-error" role="alert">{{ error() }}</p> }
      </div>
    }
  `,
  styles: `
    .tool-loop-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      padding: 8px 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      border: 1px solid var(--warning-border, rgba(245, 158, 11, 0.4));
      background: var(--warning-bg, rgba(245, 158, 11, 0.08));
      font-size: 12px;
      color: var(--text-secondary);
    }
    .tool-loop-text { flex: 1 1 260px; margin: 0; }
    .tool-loop-text strong { color: var(--text-primary); }
    .tool-loop-actions { display: flex; gap: 6px; }
    .tool-loop-btn {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 5px;
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
    }
    .tool-loop-btn:hover:not(:disabled) { background: var(--hover-bg, rgba(255, 255, 255, 0.06)); }
    .tool-loop-btn:focus-visible { outline: 2px solid var(--border-focus, var(--primary-color)); outline-offset: 2px; }
    .tool-loop-btn:disabled { cursor: default; opacity: 0.6; }
    .tool-loop-btn--primary { border-color: var(--warning-color, #f59e0b); }
    .tool-loop-error { flex-basis: 100%; margin: 0; color: var(--error-color, #ef4444); }
  `,
})
export class ToolLoopBannerComponent {
  private readonly alerts = inject(ToolLoopAlertStore);

  readonly instanceId = input.required<string>();
  protected readonly continueConsequence = TOOL_LOOP_CONTINUE_CONSEQUENCE;

  readonly alert = computed(() => this.alerts.alertFor(this.instanceId()));
  readonly summary = computed(() => {
    const alert = this.alert();
    return alert ? describeToolLoop(alert) : '';
  });

  // The store owns "stopping" so every place offering Stop agrees. The error is
  // keyed by the alert (session and detection time): the composer is reused across
  // sessions, and a later alert in the same session must not show an old failure.
  readonly stopping = computed(() => this.alerts.isStopping(this.instanceId()));
  private readonly errorState = signal<{ instanceId: string; detectedAt: number; text: string } | null>(null);
  readonly error = computed(() => {
    const state = this.errorState();
    const alert = this.alert();
    return state && alert && state.instanceId === alert.instanceId && state.detectedAt === alert.detectedAt ? state.text : null;
  });

  async stop(): Promise<void> {
    const alert = this.alert();
    if (!alert) return;
    const { instanceId, detectedAt } = alert;
    this.errorState.set(null);
    const failed = { instanceId, detectedAt, text: 'Could not stop this turn. Try the Stop button.' };
    try {
      if (!await this.alerts.stopTurn(instanceId)) this.errorState.set(failed);
    } catch {
      this.errorState.set(failed);
    }
  }

  letContinue(): void {
    this.errorState.set(null);
    this.alerts.letContinue(this.instanceId());
  }
}
