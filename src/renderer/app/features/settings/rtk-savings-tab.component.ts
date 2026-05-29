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
          <h3 class="section-title">Output compression savings</h3>
          <p class="section-desc">
            When an AI agent runs a shell command, the output can be very long.
            <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener">RTK</a>
            (Reduce Token Count) compresses that output before it is sent to the AI,
            cutting down on tokens used — which lowers cost and speeds up responses.
            The stats below come from RTK&apos;s local tracking file on this machine.
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
          Toggle changes apply to new AI sessions only. If a session is already
          running, restart it to pick up the change.
        </p>
      </div>

      @if (error(); as err) {
        <div class="error-banner">{{ err }}</div>
      }

      @if (status(); as st) {
        <div class="status-grid">
          <div class="status-row">
            <span class="status-label">RTK enabled</span>
            <span class="status-value" [attr.data-state]="st.enabled ? 'on' : 'off'">
              {{ st.enabled ? 'Enabled' : 'Disabled' }}
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">RTK program</span>
            <span class="status-value">
              @if (st.available) {
                {{ st.binarySource }} · v{{ st.version }}
              } @else {
                Not installed — RTK must be on your PATH for compression to work
              }
            </span>
          </div>
          <div class="status-row">
            <span class="status-label">Savings log</span>
            <span class="status-value">
              @if (st.trackingDbAvailable) {
                Found
              } @else {
                Not found — RTK has not run a compression yet
              }
            </span>
          </div>
        </div>
      }

      @if (summary(); as s) {
        <div class="summary-grid">
          <div class="summary-card">
            <div class="summary-label">Shell commands compressed</div>
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
          <h4 class="section-subhead">Top shell commands by tokens saved</h4>
          <table class="rtk-table">
            <thead>
              <tr>
                <th>Shell command</th>
                <th class="num">Runs</th>
                <th class="num">Tokens saved</th>
                <th class="num">Avg saving</th>
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
            No compressions recorded yet. Make sure RTK is enabled above, then
            start a Claude session and ask it to run a shell command
            (for example: &ldquo;run git status&rdquo;). The table will fill in
            as RTK compresses command output.
          </p>
        }
      } @else if (!loading() && !error()) {
        <p class="empty">No savings data yet. Click Refresh to load the latest stats.</p>
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
