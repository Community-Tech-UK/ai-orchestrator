/**
 * Session status card: a slim, closed-by-default row in the session view that opens to
 * the session's status and, for a Claude session, where this session's usage went.
 *
 * The status words, colour and dot come from the shared status presenter (through
 * `app-status-indicator`), so this card can never disagree with the header or the
 * sidebar. The usage card is only created once the row is opened, so a session that is
 * merely looked at never asks the main process to read any transcripts.
 *
 * Mounted by the session view with `<app-session-status-card [instance]="inst" />`.
 */

import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { presentInstanceStatus } from '../../../../shared/attention/instance-status-presentation';
import { USAGE_UNSUPPORTED_TEXT } from '../../../../shared/usage-insight/usage-cause-copy';
import type { Instance } from '../../core/state/instance.store';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { UsageWhereWentCardComponent } from '../usage-insight/usage-where-went-card.component';

let nextPanelId = 0;

@Component({
  selector: 'app-session-status-card',
  standalone: true,
  imports: [StatusIndicatorComponent, UsageWhereWentCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="ssc-toggle"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() ? panelId : null"
      (click)="toggle()"
    >
      <svg class="ssc-chevron" [class.ssc-chevron-open]="open()" width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
      Status and usage
    </button>

    @if (open()) {
      <section class="ssc-panel" [id]="panelId" aria-label="Session status and usage" data-testid="session-status-panel">
        <div class="ssc-status">
          <app-status-indicator
            [status]="instance().status"
            [showLabel]="true"
            [waitReason]="instance().waitReason"
            [backgroundWorkCount]="instance().backgroundWork?.count ?? 0"
          />
          @if (statusSentence(); as sentence) {
            <p class="ssc-sentence" data-testid="session-status-sentence">{{ sentence }}</p>
          }
        </div>

        @if (isClaude()) {
          <app-usage-where-went-card [instanceId]="instance().id" />
        } @else {
          <p class="ssc-note" data-testid="session-usage-unsupported">{{ notClaudeText }}</p>
        }
      </section>
    }
  `,
  styles: [`
    :host {
      display: block;
      flex-shrink: 0;
    }

    .ssc-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 999px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .ssc-toggle:hover {
      color: var(--text-secondary);
      border-color: rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
    }

    .ssc-toggle[aria-expanded='true'] {
      color: var(--primary-color);
      border-color: rgba(var(--primary-rgb), 0.24);
      background: rgba(var(--primary-rgb), 0.1);
    }

    .ssc-chevron {
      transition: transform var(--transition-fast);
    }

    .ssc-chevron-open {
      transform: rotate(180deg);
    }

    .ssc-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      max-height: 40vh;
      overflow-y: auto;
      margin-top: var(--spacing-xs);
      padding: 8px;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 18px;
      background: var(--bg-elevated, rgba(255, 255, 255, 0.02));
    }

    .ssc-status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .ssc-sentence,
    .ssc-note {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted);
    }
  `],
})
export class SessionStatusCardComponent {
  readonly instance = input.required<Instance>();

  /** The id alone, so the row only resets for another session and not when this one's status changes. */
  private readonly sessionId = computed(() => this.instance().id);

  /** Opening is per session: selecting another session closes the row again. */
  protected readonly open = linkedSignal<string, boolean>({
    source: this.sessionId,
    computation: () => false,
  });

  protected readonly panelId = `session-status-panel-${nextPanelId++}`;
  protected readonly notClaudeText = USAGE_UNSUPPORTED_TEXT['not-claude'];

  /** Usage is only broken down for Claude, whose transcripts carry per-request detail. */
  protected readonly isClaude = computed(() => this.instance().provider === 'claude');

  /** The presenter's fragment as a sentence; empty when the label already says everything. */
  protected readonly statusSentence = computed(() => {
    const instance = this.instance();
    const { detail } = presentInstanceStatus(instance.status, instance.waitReason, {
      backgroundWorkCount: instance.backgroundWork?.count ?? 0,
    });
    return detail ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.` : '';
  });

  protected toggle(): void {
    this.open.update((open) => !open);
  }
}
