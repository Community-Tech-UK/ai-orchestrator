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
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-rtk-savings-tab',
  standalone: true,
  imports: [DecimalPipe, SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rtk-tab">
      <header class="rtk-header">
        <div>
          <h3 class="section-title">Compression savings</h3>
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

      <div class="rtk-toggles">
        @for (setting of settingsStore.rtkSettings(); track setting.key) {
          <app-setting-row
            [setting]="setting"
            [value]="settingsStore.get(setting.key)"
            (valueChange)="onSettingChange($event)"
          />
        }
        <p class="rtk-hint">
          Changes take effect for newly spawned instances. Restart any running
          instance to pick up a flipped flag.
        </p>
      </div>

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
  styleUrl: './rtk-savings-tab.component.scss',
})
export class RtkSavingsTabComponent implements OnInit {
  private readonly ipc = inject(RtkIpcService);
  protected readonly settingsStore = inject(SettingsStore);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<RtkStatusData | null>(null);
  protected readonly summary = signal<RtkSavingsSummary | null>(null);

  ngOnInit(): void {
    void this.refresh();
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.settingsStore.set(
      event.key as keyof AppSettings,
      event.value as AppSettings[keyof AppSettings],
    );
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
