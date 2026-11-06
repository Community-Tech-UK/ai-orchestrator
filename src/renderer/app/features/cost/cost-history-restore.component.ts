/**
 * LT-707 cost history restoration card.
 *
 * Explicit, user-triggered maintenance surface for restoring the Claude turn
 * costs the old A0 history repair reduced. Every run is previewed read-only
 * first (status totals), applied atomically and reversible from the rollback
 * snapshot. Nothing here runs automatically.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CostIpcService } from '../../core/services/ipc/cost-ipc.service';
import type {
  CostRestoreInspection,
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../../../shared/types/cost-history-restore.types';

@Component({
  selector: 'app-cost-history-restore',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="cost-history-restore" aria-labelledby="cost-history-restore-title">
      <div class="restore-header">
        <span class="title" id="cost-history-restore-title">Cost history restoration</span>
      </div>
      <p class="restore-copy">
        An earlier maintenance pass reduced some recorded Claude turn costs that were already correct.
        This restores only the affected rows to their original values from the automatic backup; other
        records stay as they are, and the restoration can be undone.
      </p>
      @if (status(); as snapshot) {
        @if (snapshot.claudeCutoff === null) {
          <p class="restore-status warn">
            The per-turn booking boundary cannot be resolved on this install, so restoration cannot run.
          </p>
        } @else if (snapshot.mismatchedRows > 0) {
          <p class="restore-status warn">
            {{ snapshot.mismatchedRows }} of {{ snapshot.scopedRows }} checked rows differ from their
            originals: \${{ snapshot.currentUsd.toFixed(2) }} recorded versus
            \${{ snapshot.originalUsd.toFixed(2) }} original.
          </p>
        } @else {
          <p class="restore-status ok">
            All {{ snapshot.scopedRows }} checked rows already match their original values.
          </p>
        }
        @if (snapshot.unverifiedRows > 0) {
          <p class="restore-status warn">
            {{ snapshot.unverifiedRows }} rows cannot be identified as affected Claude rows with
            confidence, so they stay as they are.
          </p>
        }
      } @else if (loading()) {
        <p class="restore-status">Checking recorded history…</p>
      }
      <p
        class="restore-message"
        [class.error]="messageIsError()"
        [attr.role]="messageIsError() ? 'alert' : 'status'"
        [attr.aria-live]="messageIsError() ? 'assertive' : 'polite'"
      >{{ message() }}</p>
      <div class="restore-actions">
        @if (confirming()) {
          <span class="confirm-copy">Restore the affected rows to their original values?</span>
          <button type="button" class="primary" (click)="apply()" [disabled]="busy()">Confirm restore</button>
          <button type="button" (click)="confirming.set(false)" [disabled]="busy()">Cancel</button>
        } @else {
          <button
            type="button"
            class="primary"
            (click)="confirming.set(true)"
            [disabled]="busy() || !canRestore()"
          >Restore original costs</button>
          <button type="button" (click)="rollback()" [disabled]="busy()">Undo last restoration</button>
          <button type="button" (click)="refresh()" [disabled]="busy()">Check again</button>
        }
      </div>
    </section>
  `,
  styles: [`
    .cost-history-restore {
      border: 1px solid var(--border-color, #d0d0d0);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .restore-header .title { font-weight: 600; }
    .restore-copy, .restore-status, .restore-message { margin: 0; font-size: 12px; line-height: 1.5; }
    .restore-status.warn { color: var(--pill-warn-fg); }
    .restore-status.ok { color: var(--pill-ok-fg); }
    .restore-message.error { color: var(--pill-error-fg); }
    .restore-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .confirm-copy { font-size: 12px; }
    button {
      border: 1px solid var(--border-color, #d0d0d0);
      border-radius: 6px;
      padding: 4px 12px;
      background: transparent;
      cursor: pointer;
    }
    button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
    button:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class CostHistoryRestoreComponent implements OnInit {
  private readonly costIpc = inject(CostIpcService);

  readonly status = signal<CostRestoreInspection | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly confirming = signal(false);
  readonly message = signal<string | null>(null);
  readonly messageIsError = signal(false);
  readonly canRestore = computed(() => (this.status()?.mismatchedRows ?? 0) > 0);

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const response = await this.costIpc.costHistoryRestoreStatus();
      this.status.set(response.success && response.data ? response.data : null);
      if (!response.success) this.showMessage(response.error?.message ?? 'Could not read cost history.', true);
    } finally {
      this.loading.set(false);
    }
  }

  async apply(): Promise<void> {
    this.confirming.set(false);
    await this.run(
      () => this.costIpc.costHistoryRestoreApply(),
      (result: CostRestoreSummary) => {
        switch (result.status) {
          case 'restored':
            this.showMessage(`Restored ${result.rows} rows ($${result.beforeUsd.toFixed(2)} → $${result.afterUsd.toFixed(2)}).`, false);
            break;
          case 'noop':
            this.showMessage('Nothing to restore: recorded history already matches its originals.', false);
            break;
          case 'missing-cutoff':
            this.showMessage('Restoration did not run: the per-turn booking boundary is unavailable.', true);
            break;
          default:
            this.showMessage('Restoration failed and was rolled back; recorded history is unchanged.', true);
        }
      },
    );
  }

  async rollback(): Promise<void> {
    await this.run(
      () => this.costIpc.costHistoryRestoreRollback(),
      (result: CostRestoreRollbackSummary) => {
        switch (result.status) {
          case 'rolled-back':
            this.showMessage(`Undid the restoration of ${result.rows} rows.`, false);
            break;
          case 'noop':
            this.showMessage('No restoration to undo.', false);
            break;
          default:
            this.showMessage('Undo failed and was rolled back; recorded history is unchanged.', true);
        }
      },
    );
  }

  private async run<T>(
    invoke: () => Promise<{ success: boolean; data?: T; error?: { message?: string } }>,
    describe: (result: T) => void,
  ): Promise<void> {
    this.busy.set(true);
    try {
      const response = await invoke();
      if (response.success && response.data !== undefined) {
        describe(response.data);
      } else {
        this.showMessage(response.error?.message ?? 'The maintenance action failed.', true);
      }
    } finally {
      this.busy.set(false);
      await this.refresh();
    }
  }

  private showMessage(text: string, isError: boolean): void {
    this.message.set(text);
    this.messageIsError.set(isError);
  }
}
