/**
 * Provider Quota Settings Tab
 *
 * Per-provider opt-in for background quota polling. When enabled, the main
 * process spawns the provider's status probe on the configured cadence so
 * the chip stays current without the user having to refresh by hand.
 *
 * Off by default everywhere — see docs/architecture for the rationale (no
 * surprise CPU/network on quiet sessions). Selections persist to
 * localStorage and are re-applied on app start.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../../../shared/types/provider-quota.types';

interface IntervalOption {
  label: string;
  ms: number;
}

interface LimitRow {
  label: string;
  value: string;
  reset: string | null;
}

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'copilot', label: 'GitHub Copilot' },
];

const INTERVAL_OPTIONS: IntervalOption[] = [
  { label: 'Off', ms: 0 },
  { label: 'Every 5 min', ms: 5 * 60 * 1000 },
  { label: 'Every 15 min', ms: 15 * 60 * 1000 },
  { label: 'Every 30 min', ms: 30 * 60 * 1000 },
  { label: 'Every hour', ms: 60 * 60 * 1000 },
];

const LIMIT_UNAVAILABLE_TEXT: Record<ProviderId, string> = {
  claude: 'Numeric limits unavailable. Claude Code currently exposes plan/sign-in only outside the interactive UI.',
  codex: 'Numeric limits unavailable. Codex exposes login method only; account limits are not available headlessly.',
  gemini: 'Numeric limits unavailable. Gemini exposes auth type only; quota stats are interactive-session data.',
  copilot: 'Numeric limits unavailable. Copilot exposes sign-in only; /usage is current-session statistics.',
};

@Component({
  standalone: true,
  selector: 'app-provider-quota-settings-tab',
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="quota-settings-tab">
      <div class="tab-header">
        <h3 class="section-title">Provider Quota</h3>
        <p class="section-desc">
          Background polling for each provider's quota probe. Off by default —
          turn on the providers you want auto-refreshed in the title-bar chip.
        </p>
      </div>

      <table class="quota-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Current state</th>
            <th>Usage limits</th>
            <th>Auto-refresh</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (p of providers; track p.id) {
            <tr>
              <td class="provider-cell">{{ p.label }}</td>
              <td class="state-cell">{{ stateText(p.id) }}</td>
              <td class="limits-cell">
                @if (limitRows(p.id).length > 0) {
                  @for (row of limitRows(p.id); track row.label) {
                    <div class="limit-row">
                      <span class="limit-label">{{ row.label }}</span>
                      <span class="limit-value">{{ row.value }}</span>
                      @if (row.reset) {
                        <span class="limit-reset">{{ row.reset }}</span>
                      }
                    </div>
                  }
                } @else {
                  <span class="limit-unavailable">{{ limitUnavailableText(p.id) }}</span>
                }
              </td>
              <td class="interval-cell">
                <select
                  [value]="intervals()[p.id]"
                  (change)="onIntervalChange(p.id, $event)"
                  [attr.aria-label]="'Polling interval for ' + p.label"
                >
                  @for (opt of intervalOptions; track opt.ms) {
                    <option [value]="opt.ms">{{ opt.label }}</option>
                  }
                </select>
              </td>
              <td class="action-cell">
                <button
                  type="button"
                  class="btn-link"
                  (click)="refresh(p.id)"
                >Refresh now</button>
              </td>
            </tr>
          }
        </tbody>
      </table>

      <div class="footer-actions">
        <button type="button" class="btn-link" (click)="refreshAll()">
          Refresh all providers
        </button>
        @if (lastWarning()) {
          <span class="warning">⚠ {{ lastWarning()!.window.label }} at
            {{ lastWarning()!.threshold }}%</span>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .quota-settings-tab { padding: 1rem 1.25rem; }
    .section-title { font-size: 1rem; font-weight: 700; margin: 0 0 4px; }
    .section-desc { color: var(--text-secondary, #cbd5e1); margin: 0 0 1rem; font-size: 0.8125rem; }

    .quota-table {
      width: 100%; border-collapse: collapse;
      font-size: 0.8125rem;
    }
    .quota-table th {
      text-align: left; font-weight: 600; padding: 0.5rem 0.75rem;
      color: var(--text-secondary, #94a3b8);
      border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
    }
    .quota-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.04));
    }
    .provider-cell { font-weight: 600; }
    .state-cell { color: var(--text-secondary, #cbd5e1); }
    .state-cell.error { color: #ef4444; }
    .limits-cell { max-width: 360px; color: var(--text-secondary, #cbd5e1); }
    .limit-row {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.375rem;
      line-height: 1.35;
    }
    .limit-row + .limit-row { margin-top: 0.375rem; }
    .limit-label { color: var(--text-primary, #e5e5e5); font-weight: 600; }
    .limit-value { color: var(--text-secondary, #cbd5e1); }
    .limit-reset { color: var(--text-muted, #94a3b8); font-size: 0.75rem; }
    .limit-unavailable {
      display: inline-block;
      max-width: 34rem;
      color: var(--text-muted, #94a3b8);
      font-size: 0.75rem;
      line-height: 1.35;
    }

    .interval-cell select {
      padding: 4px 8px; font-size: 0.8125rem;
      background: var(--bg-input, #1e293b); color: var(--text-primary, #e5e5e5);
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.12));
      border-radius: 6px;
    }

    .btn-link {
      background: transparent; border: none; padding: 0;
      color: var(--accent, #3b82f6); cursor: pointer; font-size: 0.8125rem;
    }
    .btn-link:hover { text-decoration: underline; }

    .footer-actions {
      display: flex; gap: 1rem; align-items: center;
      margin-top: 1rem;
    }
    .warning {
      color: #eab308; font-size: 0.8125rem;
    }
  `],
})
export class ProviderQuotaSettingsTabComponent implements OnInit {
  private store = inject(ProviderQuotaStore);

  readonly providers = PROVIDERS;
  readonly intervalOptions = INTERVAL_OPTIONS;

  readonly intervals = signal<Record<ProviderId, number>>({
    claude: 0, codex: 0, gemini: 0, copilot: 0,
  });

  readonly lastWarning = this.store.lastWarning;

  private readonly snapshots = computed(() => this.store.snapshots());

  ngOnInit(): void {
    void this.store.initialize();
    this.intervals.set(this.store.readPollIntervals());
  }

  stateText(provider: ProviderId): string {
    const snap: ProviderQuotaSnapshot | null = this.snapshots()[provider];
    if (!snap) return '—';
    if (!snap.ok) return snap.error ?? 'Error';
    const plan = snap.plan ?? 'signed in';
    return `Signed in · ${plan}`;
  }

  limitRows(provider: ProviderId): LimitRow[] {
    const snap: ProviderQuotaSnapshot | null = this.snapshots()[provider];
    if (!snap?.ok) return [];

    return snap.windows
      .filter((window) => window.limit > 0)
      .map((window) => ({
        label: window.label,
        value: `${window.used}/${window.limit} ${window.unit}`,
        reset: window.resetsAt ? `resets ${this.formatReset(window.resetsAt)}` : null,
      }));
  }

  limitUnavailableText(provider: ProviderId): string {
    const snap: ProviderQuotaSnapshot | null = this.snapshots()[provider];
    if (!snap) return 'No quota snapshot yet. Click refresh to run this provider probe.';
    if (!snap.ok) return 'Probe failed before usage limits could be checked.';
    return LIMIT_UNAVAILABLE_TEXT[provider];
  }

  onIntervalChange(provider: ProviderId, event: Event): void {
    const target = event.target as HTMLSelectElement;
    const ms = Number(target.value);
    if (!Number.isFinite(ms) || ms < 0) return;
    this.intervals.update((m) => ({ ...m, [provider]: ms }));
    void this.store.setPollInterval(provider, ms);
  }

  refresh(provider: ProviderId): void {
    void this.store.refresh(provider);
  }

  refreshAll(): void {
    void this.store.refreshAll();
  }

  private formatReset(resetsAt: number): string {
    const ms = resetsAt - Date.now();
    if (ms <= 0) return 'now';

    const totalMinutes = Math.ceil(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  }
}
