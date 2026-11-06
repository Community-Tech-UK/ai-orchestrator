/**
 * "Claude cost check" panel for the Costs page.
 *
 * Shows the daily comparison between what Harness booked for Claude sessions and
 * Claude's own running total for the same sessions, and warns when they are more
 * than 5% apart. Self-contained (its own IPC service and state) so the main Costs
 * template only needs one line: <app-claude-cost-drift />.
 */

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { presentError } from '../../../../shared/present-error';
import { ClaudeCostReconcileIpcService } from '../../core/services/ipc/claude-cost-reconcile-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import type {
  ClaudeCostReconcileGroup,
  ClaudeCostReconcileSession,
  ClaudeCostReconcileSnapshot,
} from '../../../../shared/types/claude-cost-reconcile.types';

const usd = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function describeDrift(driftPct: number | null): string {
  if (driftPct === null) return 'no Claude spend to compare';
  const size = `${Math.abs(driftPct).toFixed(1)}%`;
  if (Math.abs(driftPct) < 0.05) return 'matches exactly';
  return driftPct < 0 ? `${size} below Claude's figure` : `${size} above Claude's figure`;
}

/** Short phrase for one group; the zero-spend case has no meaningful percentage. */
export function describeGroupDrift(group: Pick<ClaudeCostReconcileGroup, 'driftPct' | 'cliUsd' | 'storedUsd'>): string {
  return group.cliUsd <= 0 && group.storedUsd > 0 ? `booked ${usd(group.storedUsd)} where Claude reports none` : describeDrift(group.driftPct);
}

@Component({
  selector: 'app-claude-cost-drift',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="drift" aria-labelledby="claude-cost-drift-title">
      <header class="drift-header">
        <h3 id="claude-cost-drift-title">Claude cost check</h3>
        <button type="button" class="check-btn" [disabled]="checking()" (click)="checkNow()">
          {{ checking() ? 'Checking…' : 'Check now' }}
        </button>
      </header>

      @if (errorMessage()) {
        <p class="note error" role="alert">{{ errorMessage() }}</p>
        @if (errorDetail()) { <details class="note"><summary>Details</summary>{{ errorDetail() }}</details> }
      }

      @if (report(); as r) {
        <p class="verdict" [class.warn]="r.status === 'drift'" role="status">
          @switch (r.status) {
            @case ('drift') { <strong>Over {{ r.thresholdPct }}% apart.</strong> {{ verdictSentence(r.total) }} }
            @case ('ok') { Harness's Claude costs agree with Claude's own figures (within {{ r.thresholdPct }}%). }
            @default { Not enough finished Claude sessions to compare yet. }
          }
        </p>
        <p class="detail">
          Checked {{ checkedAt() }}. Compared {{ r.coverage.compared }} sessions:
          Harness {{ money(r.total.storedUsd) }}, Claude {{ money(r.total.cliUsd) }}.
        </p>

        <ul class="eras">
          @if (r.byEra['per-turn'].sessions > 0) {
            <li>Booked turn by turn: {{ r.byEra['per-turn'].sessions }} sessions, {{ driftText(r.byEra['per-turn']) }}.</li>
          }
          @if (r.byEra.repaired.sessions > 0) {
            <li>Older sessions, rebuilt from running totals: {{ r.byEra.repaired.sessions }} sessions, {{ driftText(r.byEra.repaired) }}.</li>
          }
        </ul>

        <p class="detail muted">
          Left out: {{ r.coverage.unsettled }} still running or unfinished,
          {{ r.coverage.noTranscript }} with no transcript on this computer,
          {{ r.coverage.unknownModelCost }} Claude could not price.
        </p>

        @if (r.status === 'drift' && r.largestGaps.length > 0) {
          <table class="gaps">
            <caption>Biggest differences</caption>
            <thead><tr><th scope="col">Session</th><th scope="col">Harness</th><th scope="col">Claude</th><th scope="col">Difference</th></tr></thead>
            <tbody>
              @for (gap of r.largestGaps; track gap.sessionId) {
                <tr>
                  <td class="mono">{{ shortId(gap) }}</td>
                  <td>{{ money(gap.storedUsd) }}</td>
                  <td>{{ money(gap.cliUsd) }}</td>
                  <td>{{ signed(gap.gapUsd) }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      } @else {
        <p class="detail">Not checked yet. The first check runs a couple of minutes after Harness starts, then once a day.</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .drift { border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary); padding: var(--spacing-md); display: flex; flex-direction: column; gap: var(--spacing-sm); }
    .drift-header { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
    h3 { margin: 0; font-size: 14px; font-weight: 700; color: var(--text-primary); }
    .check-btn { border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); cursor: pointer; }
    .check-btn:disabled { opacity: 0.6; cursor: default; }
    .verdict { margin: 0; color: var(--text-primary); }
    .verdict.warn { color: var(--warning-color); background: var(--warning-bg); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .muted { color: var(--text-muted); }
    .note.error { margin: 0; color: var(--error-color); }
    .eras { margin: 0; padding-left: var(--spacing-md); font-size: 12px; color: var(--text-secondary); }
    .gaps { width: 100%; border-collapse: collapse; font-size: 12px; }
    .gaps caption { text-align: left; color: var(--text-muted); padding-bottom: var(--spacing-xs); }
    .gaps th, .gaps td { text-align: left; padding: var(--spacing-xs); border-top: 1px solid var(--border-color); }
    .mono { font-family: var(--font-family-mono); }
  `],
})
export class ClaudeCostDriftComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(ClaudeCostReconcileIpcService);
  private readonly pollScheduler = inject(RendererPollSchedulerService);
  private stopPolling: (() => void) | null = null;
  /** Moves when a Check now starts and again when it ends, so a refresh that began earlier knows it is out of date. */
  private checkEpoch = 0;

  readonly snapshot = signal<ClaudeCostReconcileSnapshot | null>(null);
  readonly checking = signal(false);
  readonly errorMessage = signal('');
  readonly errorDetail = signal('');

  readonly report = computed(() => this.snapshot()?.latest ?? null);
  readonly checkedAt = computed(() => {
    const at = this.report()?.checkedAt;
    return at === undefined ? '' : new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  });

  ngOnInit(): void {
    void this.load();
    // The check runs in the background once a day; pick up a finished one while the page is open.
    this.stopPolling = this.pollScheduler.register(() => this.load(), 60_000);
  }

  ngOnDestroy(): void {
    this.stopPolling?.();
  }

  async load(): Promise<void> {
    const epoch = this.checkEpoch;
    await this.apply(() => this.ipc.get(), () => epoch === this.checkEpoch);
  }

  async checkNow(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    this.checkEpoch += 1;
    try {
      await this.apply(() => this.ipc.run(), () => true);
    } finally {
      this.checkEpoch += 1;
      this.checking.set(false);
    }
  }

  driftText(group: ClaudeCostReconcileGroup): string {
    return describeGroupDrift(group);
  }

  verdictSentence(group: ClaudeCostReconcileGroup): string {
    return group.cliUsd <= 0 && group.storedUsd > 0
      ? `Harness booked ${usd(group.storedUsd)} for sessions where Claude reports no spend.`
      : `Harness's Claude costs are ${describeDrift(group.driftPct)}.`;
  }

  money(value: number): string {
    return usd(value);
  }

  signed(value: number): string {
    return `${value < 0 ? '-' : '+'}${usd(Math.abs(value))}`;
  }

  shortId(gap: ClaudeCostReconcileSession): string {
    return gap.sessionId.slice(0, 8);
  }

  /** `isCurrent` is false for a background refresh that a Check now has overtaken: its answer is older, so it is dropped. */
  private async apply(call: () => Promise<{ success: boolean; data?: ClaudeCostReconcileSnapshot; error?: unknown }>, isCurrent: () => boolean): Promise<void> {
    try {
      const response = await call();
      if (!isCurrent()) return;
      if (response.success && response.data) {
        this.snapshot.set(response.data);
        this.errorMessage.set(response.data.lastError ? 'The last check failed, so these figures may be out of date.' : '');
        this.errorDetail.set('');
      } else {
        this.errorMessage.set('Could not load the Claude cost check.');
        this.errorDetail.set(presentError(response.error).rawDetail);
      }
    } catch {
      if (isCurrent()) this.errorMessage.set('Could not load the Claude cost check.');
    }
  }
}
