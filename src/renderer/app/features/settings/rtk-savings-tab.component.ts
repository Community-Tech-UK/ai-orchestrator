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
  OnDestroy,
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
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { GlossaryTermComponent } from '../../shared/glossary/glossary-term.component';

type WindowChoice = 7 | 30 | 90 | 0;

@Component({
  selector: 'app-rtk-savings-tab',
  standalone: true,
  imports: [DecimalPipe, SettingRowComponent, AioTooltipDirective, GlossaryTermComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rtk-tab">
      <header class="rtk-header">
        <div>
          <h3 class="section-title"><app-term term="rtk">Output compression</app-term> savings</h3>
          <p class="section-desc">
            When an AI agent runs a shell command, the output can be very long.
            <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener">RTK (Rust Token Killer)</a>
            shortens that output before it is sent to the AI.
            The stats below come from RTK&apos;s local tracking file on this machine.
          </p>
          <p class="section-desc rtk-caveat">
            <strong>These numbers cover long command output only. RTK&apos;s own test
            found the overall bill stayed flat, because agents ran a few extra commands.</strong>
            These are estimates from RTK&apos;s tracking file, not your provider&apos;s bill.
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
          Changes apply to new sessions.
        </p>
      </div>

      @if (error(); as err) {
        <div class="error-banner">{{ err }}</div>
      }

      @if (status(); as st) {
        <div class="status-grid">
          <div class="status-row">
            <span class="status-label">Output compression enabled</span>
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
                Harness could not start the bundled copy
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
        @if (st.trial; as trial) {
          <p class="rtk-hint">Trial running: {{ trial.sessionsWithHook }} sessions with RTK,
            {{ trial.sessionsWithout }} without.
            @if (trial.startedAt) { Started {{ trial.startedAt }}. }
          </p>
        }
        <h4 class="section-subhead" [appTooltip]="copy('rtk.scope')">Where it applies</h4>
        <table class="rtk-table">
          <thead><tr><th>Surface</th><th>Mode</th><th>What happens</th></tr></thead>
          <tbody>
            @for (row of st.coverage ?? []; track row.surface) {
              <tr><td>{{ row.surface }}</td><td>{{ row.mode }}</td><td>{{ row.note }}</td></tr>
            }
          </tbody>
        </table>
      }

      <div class="rtk-window" role="group" aria-label="Time window">
        @for (choice of windowChoices; track choice.days) {
          <button type="button" class="btn window-btn"
            [attr.aria-pressed]="windowDays() === choice.days"
            (click)="setWindow(choice.days)">{{ choice.label }}</button>
        }
      </div>

      @if (summary(); as s) {
        <p class="section-desc">{{ windowRangeLabel() }} @if (loading()) { <span role="status">· Refreshing…</span> }</p>
        @for (burst of s.projectBursts ?? []; track burst.projectPath) {
          <p class="error-banner" role="status">
            {{ burst.projectPath }} called RTK {{ burst.commands | number }} times in the last hour.
            Check for repeated shell commands, especially git cat-file.
          </p>
        }
        <div class="summary-grid">
          <div class="summary-card">
            <div class="summary-label" [appTooltip]="copy('rtk.filtered')">Commands made shorter</div>
            <div class="summary-value">{{ s.commandsFiltered | number }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label" [appTooltip]="copy('rtk.ranInFull')">Ran in full (not shortened)</div>
            <div class="summary-value">{{ s.commandsRanInFull | number }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label" [appTooltip]="copy('rtk.savedCapped')">Output tokens saved (estimate)</div>
            <div class="summary-value">{{ s.savedTokensCapped | number }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label" [appTooltip]="copy('rtk.weighted')">Typical reduction on shortened commands</div>
            <div class="summary-value">{{ s.weightedReductionPct | number: '1.0-1' }}%</div>
          </div>
        </div>

        @if (s.byProgram.length > 0) {
          <h4 class="section-subhead">Shortened output saved by program</h4>
          <table class="rtk-table">
            <thead><tr><th>Program</th><th class="num">Runs</th><th class="num">Tokens saved (est.)</th></tr></thead>
            <tbody>
              @for (row of s.byProgram; track row.program) {
                <tr><td>{{ row.program }}</td><td class="num">{{ row.count | number }}</td>
                  <td class="num">{{ row.savedTokensCapped | number }}</td></tr>
              }
            </tbody>
          </table>
        }

        @if (s.commands === 0) {
          <p class="empty">
            No compressions recorded yet.
          </p>
        }
      } @else if (!loading() && !error()) {
        <p class="empty">No savings data yet. Click Refresh to load the latest stats.</p>
      }
    </section>
  `,
  styleUrl: './rtk-savings-tab.component.scss',
})
export class RtkSavingsTabComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(RtkIpcService);
  protected readonly settingsStore = inject(SettingsStore);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal<RtkStatusData | null>(null);
  private readonly cachedWindow = this.ipc.lastSummary.windowDays;
  private readonly hasCachedWindow = [7, 30, 90, 0].includes(this.cachedWindow);
  protected readonly summary = signal<RtkSavingsSummary | null>(this.hasCachedWindow ? this.ipc.lastSummary.value : null);
  protected readonly copy = copyFor;
  protected readonly windowDays = signal<WindowChoice>(this.hasCachedWindow ? this.cachedWindow as WindowChoice : 7);
  protected readonly windowChoices: { days: WindowChoice; label: string; rangeLabel: string }[] = [
    { days: 7, label: '7 days', rangeLabel: 'Last 7 days' },
    { days: 30, label: '30 days', rangeLabel: 'Last 30 days' },
    { days: 90, label: '90 days', rangeLabel: 'Last 90 days' },
    { days: 0, label: 'All', rangeLabel: 'All time' },
  ];
  private refreshEpoch = 0;
  private destroyed = false;

  ngOnInit(): void {
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.refreshEpoch += 1;
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.settingsStore.set(
      event.key as keyof AppSettings,
      event.value as AppSettings[keyof AppSettings],
    );
  }

  setWindow(days: WindowChoice): void {
    this.windowDays.set(days);
    this.summary.set(null);
    void this.refresh();
  }

  protected windowRangeLabel(): string {
    return this.windowChoices.find((choice) => choice.days === this.windowDays())?.rangeLabel ?? 'Last 7 days';
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    const epoch = ++this.refreshEpoch;
    const days = this.windowDays();
    const sinceMs = days ? Date.now() - days * 86_400_000 : undefined;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [statusResp, summaryResp] = await Promise.all([
        this.ipc.getStatus(),
        this.ipc.getSummary({ topN: 10, sinceMs }),
      ]);
      if (epoch !== this.refreshEpoch) return;

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
      if (epoch === this.refreshEpoch) this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (epoch === this.refreshEpoch) this.loading.set(false);
    }
  }
}
