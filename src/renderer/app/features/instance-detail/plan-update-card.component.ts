import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ExpansionStateService } from './expansion-state.service';
import type { CopilotPlanUpdate } from './copilot-plan-update';
import { summarizeCopilotPlanUpdate } from './copilot-plan-update';

@Component({
  selector: 'app-plan-update-card',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="plan-card" [class.expanded]="isExpanded()" [class.empty]="!hasEntries()">
      <button
        class="plan-card__header"
        type="button"
        [disabled]="!hasEntries()"
        [attr.aria-expanded]="hasEntries() ? isExpanded() : null"
        (click)="toggle()">
        <span class="plan-card__toggle">{{ hasEntries() ? (isExpanded() ? '▾' : '▸') : '•' }}</span>

        <div class="plan-card__copy">
          <div class="plan-card__meta">
            <span class="plan-card__eyebrow">Plan</span>
            <span class="plan-card__time">{{ timestamp() | date: 'HH:mm:ss' }}</span>
          </div>
          <div class="plan-card__summary">{{ summary() }}</div>
          @if (plan().preview) {
            <div class="plan-card__preview" [title]="plan().preview">{{ plan().preview }}</div>
          }
        </div>
      </button>

      @if (isExpanded()) {
        <div class="plan-card__body">
          @for (entry of plan().entries; track $index) {
            <div class="plan-card__row" [class.active]="entry.statusKind === 'in_progress'">
              <span class="plan-card__status" [attr.data-status]="entry.statusKind">
                {{ entry.statusLabel }}
              </span>
              <span class="plan-card__content">{{ entry.content }}</span>
              @if (entry.priorityLabel) {
                <span class="plan-card__priority" [attr.data-priority]="entry.priorityKind">
                  {{ entry.priorityLabel }}
                </span>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .plan-card {
      width: min(100%, 780px);
      margin: 6px auto;
      border: 1px solid rgba(96, 165, 250, 0.18);
      border-radius: 16px;
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(12, 18, 31, 0.92));
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }

    .plan-card.empty {
      border-color: rgba(148, 163, 184, 0.16);
    }

    .plan-card__header {
      width: 100%;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px 16px;
      border: none;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .plan-card__header:hover:enabled {
      background: rgba(255, 255, 255, 0.02);
    }

    .plan-card__header:disabled {
      cursor: default;
    }

    .plan-card__toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      min-width: 16px;
      padding-top: 2px;
      color: rgba(147, 197, 253, 0.92);
      font-size: 12px;
      line-height: 1;
    }

    .plan-card.empty .plan-card__toggle {
      color: var(--text-muted);
    }

    .plan-card__copy {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .plan-card__meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .plan-card__eyebrow,
    .plan-card__time,
    .plan-card__priority {
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.2;
      font-weight: 600;
    }

    .plan-card__eyebrow {
      color: rgba(147, 197, 253, 0.88);
    }

    .plan-card.empty .plan-card__eyebrow {
      color: var(--text-secondary);
    }

    .plan-card__time {
      color: var(--text-muted);
      white-space: nowrap;
    }

    .plan-card__summary {
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 600;
      line-height: 1.35;
    }

    .plan-card__preview {
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.45;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .plan-card__body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 16px 16px 44px;
      border-top: 1px solid rgba(148, 163, 184, 0.12);
      background: rgba(2, 6, 23, 0.22);
    }

    .plan-card__row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding-top: 12px;
    }

    .plan-card__row.active .plan-card__content {
      color: #f8fafc;
    }

    .plan-card__status,
    .plan-card__priority {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid transparent;
      white-space: nowrap;
    }

    .plan-card__status {
      font-size: 11px;
      font-weight: 600;
    }

    .plan-card__status[data-status='completed'] {
      color: #86efac;
      background: rgba(34, 197, 94, 0.12);
      border-color: rgba(34, 197, 94, 0.24);
    }

    .plan-card__status[data-status='in_progress'] {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.14);
      border-color: rgba(59, 130, 246, 0.28);
    }

    .plan-card__status[data-status='pending'],
    .plan-card__priority[data-priority='medium'] {
      color: #fcd34d;
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.24);
    }

    .plan-card__status[data-status='cancelled'],
    .plan-card__priority[data-priority='low'] {
      color: #cbd5e1;
      background: rgba(148, 163, 184, 0.12);
      border-color: rgba(148, 163, 184, 0.18);
    }

    .plan-card__status[data-status='unknown'],
    .plan-card__priority[data-priority='unknown'] {
      color: var(--text-secondary);
      background: rgba(148, 163, 184, 0.08);
      border-color: rgba(148, 163, 184, 0.14);
    }

    .plan-card__priority[data-priority='high'] {
      color: #fda4af;
      background: rgba(244, 63, 94, 0.12);
      border-color: rgba(244, 63, 94, 0.2);
    }

    .plan-card__content {
      min-width: 0;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.45;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanUpdateCardComponent {
  plan = input.required<CopilotPlanUpdate>();
  timestamp = input.required<number>();
  instanceId = input.required<string>();
  itemId = input.required<string>();

  private readonly expansionState = inject(ExpansionStateService);

  protected readonly hasEntries = computed(() => this.plan().entries.length > 0);
  protected readonly isExpanded = computed(() =>
    this.hasEntries() && this.expansionState.isExpanded(this.instanceId(), this.itemId()),
  );
  protected readonly summary = computed(() => summarizeCopilotPlanUpdate(this.plan()));

  protected toggle(): void {
    if (!this.hasEntries()) {
      return;
    }

    this.expansionState.toggleExpanded(this.instanceId(), this.itemId());
  }
}
