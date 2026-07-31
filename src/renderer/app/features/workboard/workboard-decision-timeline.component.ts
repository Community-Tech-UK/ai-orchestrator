import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import type { OperationalDecision } from '@contracts/schemas/workboard';
import { LoopStore } from '../../core/state/loop.store';
import { WorkboardIpcService } from '../../core/services/ipc/workboard-ipc.service';
import { relativeTime } from './workboard-projection';
import type { WorkboardItem } from './workboard.types';

/** Correlated ids that identify the decision-timeline query for one item. */
function queryKey(item: WorkboardItem): string {
  return `${item.loopRunId ?? ''}|${item.automationRunId ?? ''}|${item.instanceId ?? ''}`;
}

/**
 * WS-C1: a compact, plain-language "why is this Waiting / Needs you, and what
 * moves it next?" timeline for the selected Workboard item. Reads a
 * cross-domain projection assembled on demand by the main process (see
 * `workboard-handlers.ts`) — it never mutates anything itself beyond
 * dispatching the one existing "resume loop" command an entry may offer.
 * Renders nothing when the item has no decisions (never a placeholder card).
 */
@Component({
  selector: 'app-workboard-decision-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (decisions().length > 0) {
      <section class="wb-decisions" aria-label="Decision timeline">
        <h3 class="wb-decisions-title">Decision timeline</h3>
        <ul class="wb-decisions-list">
          @for (decision of decisions(); track decision.id) {
            <li class="wb-decisions-item">
              <div class="wb-decisions-row">
                <span class="wb-decisions-time">{{ relTime(decision.at) }}</span>
                <span class="wb-decisions-text">{{ decision.title }}</span>
              </div>
              @if (decision.detail) {
                <p class="wb-decisions-detail">{{ decision.detail }}</p>
              }
              @if (decision.resumeAt) {
                <p class="wb-decisions-resume">Resumes {{ relTime(decision.resumeAt) }}</p>
              }
              @if (decision.operatorAction; as action) {
                <button
                  type="button"
                  class="wb-decisions-action"
                  [attr.aria-busy]="resuming() === action.loopRunId"
                  (click)="onResume(action)"
                >
                  {{ action.label }}
                </button>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .wb-decisions { padding: var(--space-3, 12px); border-top: 1px solid var(--border-subtle, var(--border-color)); }
    .wb-decisions-title {
      margin: 0 0 var(--space-2, 8px);
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
    }
    .wb-decisions-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3, 10px); }
    .wb-decisions-item { font-size: var(--text-sm, 12px); }
    .wb-decisions-row { display: flex; align-items: baseline; gap: var(--space-2, 8px); }
    .wb-decisions-time { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
    .wb-decisions-text { color: var(--text-primary); }
    .wb-decisions-detail { margin: 2px 0 0; color: var(--text-secondary); font-size: var(--text-xs, 11px); }
    .wb-decisions-resume { margin: 2px 0 0; color: var(--text-secondary); font-size: var(--text-xs, 11px); }
    .wb-decisions-action {
      margin-top: 4px;
      font-size: var(--text-xs, 11px);
      padding: 2px 10px;
      border-radius: var(--radius-sm, 6px);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
    }
    .wb-decisions-action:focus-visible { outline: 2px solid var(--border-focus, var(--primary-color)); outline-offset: 2px; }
  `],
})
export class WorkboardDecisionTimelineComponent {
  readonly item = input.required<WorkboardItem>();
  readonly now = input<number>(0);

  private readonly ipc = inject(WorkboardIpcService);
  private readonly loopStore = inject(LoopStore);

  private readonly decisionsSignal = signal<OperationalDecision[]>([]);
  readonly decisions = this.decisionsSignal.asReadonly();
  private readonly resumingSignal = signal<string | null>(null);
  readonly resuming = this.resumingSignal.asReadonly();

  protected readonly relTime = (at: number) => relativeTime(at, this.now() || Date.now());

  private lastKey: string | null = null;

  constructor() {
    effect(() => {
      const item = this.item();
      const key = queryKey(item);
      if (key === this.lastKey) return;
      this.lastKey = key;
      untracked(() => void this.load(item));
    });
  }

  private async load(item: WorkboardItem): Promise<void> {
    if (!item.loopRunId && !item.automationRunId && !item.instanceId) {
      this.decisionsSignal.set([]);
      return;
    }
    const response = await this.ipc.getDecisionsForItem({
      loopRunId: item.loopRunId,
      automationRunId: item.automationRunId,
      instanceId: item.instanceId,
    });
    // Stale-response guard: the item may have changed again while this
    // request was in flight.
    if (queryKey(this.item()) !== queryKey(item)) return;
    this.decisionsSignal.set(response.success ? response.data ?? [] : []);
  }

  protected async onResume(action: { kind: 'resume-loop'; label: string; loopRunId: string }): Promise<void> {
    if (this.resumingSignal() === action.loopRunId) return;
    this.resumingSignal.set(action.loopRunId);
    try {
      await this.loopStore.resume(action.loopRunId);
    } finally {
      this.resumingSignal.set(null);
      // Re-query so a satisfied "Resume now" action disappears immediately
      // instead of lingering until the next page-level refresh cycle.
      void this.load(this.item());
    }
  }
}
