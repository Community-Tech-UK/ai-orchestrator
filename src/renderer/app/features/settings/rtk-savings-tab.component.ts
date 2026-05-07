/**
 * RTK Savings settings tab.
 *
 * Reads from the main process IPC handlers (which in turn read RTK's local
 * SQLite tracking DB) and shows aggregate token savings, top commands, and
 * runtime status. Refreshes on demand and on tab open. No live polling in v1
 * to keep main-process DB load trivial.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import {
  RtkIpcService,
  type RtkSavingsSummary,
  type RtkStatusData,
} from '../../core/services/ipc/rtk-ipc.service';

@Component({
  selector: 'app-rtk-savings-tab',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rtk-tab">
      <header class="rtk-header">
        <div>
          <h3 class="section-title">RTK Token Savings</h3>
          <p class="section-desc">
            Compresses LLM-bound shell command output via the
            <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener">rtk</a>
            CLI. Stats are read from rtk's local tracking database.
          </p>
        </div>
        <button type="button" class="btn" (click)="refresh()" [disabled]="loading()">
          {{ loading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </header>

      @if (error(); as err) {
        <div class="error-banner">{{ err }}</div>
      }

      @if (status(); as st) {
        <div class="status-grid">
          <div class="status-row">
            <span class="status-label">Feature flag</span>
            <span class="status-value" [attr.data-state]="st.enabled ? 'on' : 'off'">
              {{ st.enabled ? 'Enabled' : 'Disabled' }}
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">Binary</span>
            <span class="status-value">
              @if (st.available) {
                {{ st.binarySource }} · v{{ st.version }}
              } @else {
                Not available
              }
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">Tracking DB</span>
            <span class="status-value">
              @if (st.trackingDbAvailable) {
                Found
              } @else {
                Not present (rtk has not run yet)
              }
            </span>
          </div>
        </div>
      }

      @if (summary(); as s) {
        <div class="summary-grid">
          <div class="summary-card">
            <div class="summary-label">Commands rewritten</div>
            <div class="summary-value">{{ s.commands | number }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Tokens saved</div>
            <div class="summary-value">{{ s.totalSaved | number }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Average reduction</div>
            <div class="summary-value">{{ s.avgSavingsPct | number: '1.0-1' }}%</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">Last command</div>
            <div class="summary-value">{{ s.lastCommandAt ?? '—' }}</div>
          </div>
        </div>

        @if (s.byCommand.length > 0) {
          <h4 class="section-subhead">Top commands by tokens saved</h4>
          <table class="rtk-table">
            <thead>
              <tr>
                <th>Command</th>
                <th class="num">Count</th>
                <th class="num">Saved</th>
                <th class="num">Avg %</th>
              </tr>
            </thead>
            <tbody>
              @for (row of s.byCommand; track row.rtkCmd) {
                <tr>
                  <td>{{ row.rtkCmd }}</td>
                  <td class="num">{{ row.count | number }}</td>
                  <td class="num">{{ row.saved | number }}</td>
                  <td class="num">{{ row.avgSavingsPct | number: '1.0-1' }}%</td>
                </tr>
              }
            </tbody>
          </table>
        } @else if (s.commands === 0) {
          <p class="empty">
            No commands recorded yet. Enable the feature flag and run a Claude session
            with a Bash tool call (e.g. ask it to run <code>git status</code>) to populate.
          </p>
        }
      } @else if (!loading() && !error()) {
        <p class="empty">No data yet.</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rtk-tab { padding: 16px; display: grid; gap: 16px; }
    .rtk-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .section-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
    .section-desc { margin: 0; color: var(--color-text-secondary, #888); font-size: 13px; }
    .section-subhead { margin: 8px 0 4px; font-size: 13px; font-weight: 600; }
    .error-banner {
      padding: 8px 12px; border-radius: 4px;
      background: var(--color-bg-error, #4a1f1f); color: var(--color-text-error, #f88);
      font-size: 13px;
    }
    .status-grid {
      display: grid; gap: 6px; padding: 10px 12px;
      background: var(--color-bg-elevated, #1e1e1e);
      border: 1px solid var(--color-border, #333); border-radius: 4px;
    }
    .status-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
    .status-label { color: var(--color-text-secondary, #888); }
    .status-value { font-family: var(--font-mono, monospace); }
    .status-value[data-state="on"] { color: var(--color-success, #6a9955); }
    .status-value[data-state="off"] { color: var(--color-text-secondary, #888); }
    .summary-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px;
    }
    .summary-card {
      padding: 10px 12px; border-radius: 4px;
      background: var(--color-bg-elevated, #1e1e1e);
      border: 1px solid var(--color-border, #333);
    }
    .summary-label { font-size: 11px; color: var(--color-text-secondary, #888); text-transform: uppercase; letter-spacing: 0.04em; }
    .summary-value { font-size: 18px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .rtk-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .rtk-table th, .rtk-table td { padding: 6px 10px; border-bottom: 1px solid var(--color-border, #333); text-align: left; }
    .rtk-table .num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--font-mono, monospace); }
    .empty { color: var(--color-text-secondary, #888); font-size: 13px; }
    .empty code { background: var(--color-bg-elevated, #1e1e1e); padding: 1px 4px; border-radius: 3px; }
  `],
})
export class RtkSavingsTabComponent implements OnInit {
  private readonly ipc = inject(RtkIpcService);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<RtkStatusData | null>(null);
  protected readonly summary = signal<RtkSavingsSummary | null>(null);

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [statusResp, summaryResp] = await Promise.all([
        this.ipc.getStatus(),
        this.ipc.getSummary({ topN: 10 }),
      ]);

      if (!statusResp.success) {
        this.error.set(statusResp.error?.message ?? 'Failed to load RTK status');
        return;
      }
      this.status.set(statusResp.data ?? null);

      if (!summaryResp.success) {
        this.error.set(summaryResp.error?.message ?? 'Failed to load RTK summary');
        return;
      }
      this.summary.set(summaryResp.data ?? null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }
}
