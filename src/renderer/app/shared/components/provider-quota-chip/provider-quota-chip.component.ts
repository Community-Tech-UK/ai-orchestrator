/**
 * ProviderQuotaChipComponent
 *
 * Compact pill that surfaces the most-constrained provider quota in the app.
 *
 * Display modes (chosen automatically):
 *   • 'window' — at least one provider has numerical windows. Shows the worst
 *     window's used/limit and a "resets in Xh Ym" hint, colour-banded by ratio.
 *   • 'plan'   — at least one provider returned an ok snapshot but no windows
 *     (Claude/Copilot v1). Shows e.g. "Claude · max".
 *   • 'empty'  — no useful snapshots yet (loading, all probes failed, etc.).
 *
 * The component is self-initialising: it calls `store.initialize()` on first
 * render. Mount it once anywhere in the app shell — the underlying store is
 * an injected singleton so duplicates wouldn't cause harm but are wasteful.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProviderQuotaStore } from '../../../core/state/provider-quota.store';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';

export type QuotaChipVariant = 'window' | 'plan' | 'empty';
export type QuotaChipBand = 'green' | 'yellow' | 'orange' | 'red';

const BAND_COLORS: Record<QuotaChipBand, { fg: string; bg: string }> = {
  green:  { fg: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  yellow: { fg: '#eab308', bg: 'rgba(234,179,8,0.12)' },
  orange: { fg: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  red:    { fg: '#ef4444', bg: 'rgba(239,68,68,0.14)' },
};
const NEUTRAL = { fg: '#9a9aa0', bg: 'rgba(154,154,160,0.10)' };

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

@Component({
  selector: 'app-provider-quota-chip',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="quota-shell">
      <button
        type="button"
        class="chip"
        data-testid="quota-toggle"
        [class.window]="variant() === 'window'"
        [class.plan]="variant() === 'plan'"
        [class.empty]="variant() === 'empty'"
        [class.open]="popoverOpen()"
        [style.color]="palette().fg"
        [style.background]="palette().bg"
        [title]="tooltip()"
        [attr.aria-expanded]="popoverOpen()"
        aria-label="Provider quota details"
        (click)="togglePopover()"
      >
        <span class="dot" [style.background]="palette().fg"></span>
        <span class="strip" data-testid="quota-strip">
          @if (stripEntries().length > 0) {
            @for (entry of stripEntries(); track entry.provider) {
              <span class="provider-entry" [class.warn]="entry.percent >= 75" [class.danger]="entry.percent >= 90">
                <span class="provider-code">{{ entry.code }}</span>
                <span class="provider-value">{{ entry.value }}</span>
              </span>
            }
          } @else {
            <span class="text">{{ primaryText() }}</span>
            @if (secondaryText()) {
              <span class="aux">· {{ secondaryText() }}</span>
            }
          }
        </span>
      </button>

      @if (popoverOpen()) {
        <span class="popover" data-testid="quota-popover" role="dialog" aria-label="Provider quota details">
          @for (provider of detailEntries(); track provider.provider) {
            <span class="provider-detail" [attr.data-testid]="'quota-provider-' + provider.provider">
              <span class="provider-header">
                <span class="provider-title">
                  <span class="provider-heading">{{ provider.label }}</span>
                  <span class="provider-age">{{ provider.updatedText }}</span>
                </span>
                <button
                  type="button"
                  class="refresh-button"
                  [attr.data-testid]="'quota-refresh-' + provider.provider"
                  (click)="refreshProvider(provider.provider)"
                >Refresh</button>
              </span>
              @if (provider.windows.length > 0) {
                @for (window of provider.windows; track window.id) {
                  <span class="window-row">
                    <span class="window-label">{{ window.label }}</span>
                    <span class="window-value">{{ formatWindowValue(window) }}</span>
                    <span class="bar"><span class="bar-fill" [style.width.%]="windowPercent(window)"></span></span>
                    @if (window.resetsAt) {
                      <span class="window-reset">resets {{ formatReset(window.resetsAt) }}</span>
                    }
                  </span>
                }
              } @else {
                <span class="window-row muted">{{ provider.status }}</span>
              }
            </span>
          }
        </span>
      }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; position: relative; }
    .quota-shell { display: inline-flex; position: relative; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px 5px 8px; border-radius: 999px; border: 0;
      font: inherit; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0;
      white-space: nowrap; cursor: pointer;
      -webkit-app-region: no-drag;
      transition: all var(--transition-normal, 0.2s);
    }
    .chip.open { box-shadow: 0 0 0 1px currentColor; }
    .chip.empty { font-weight: 500; opacity: 0.85; }
    .dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .strip { display: inline-flex; align-items: center; gap: 8px; }
    .provider-entry { display: inline-flex; align-items: baseline; gap: 3px; color: inherit; }
    .provider-entry.warn { color: #f97316; }
    .provider-entry.danger { color: #ef4444; }
    .provider-code { font-weight: 700; }
    .provider-value { opacity: 0.82; font-variant-numeric: tabular-nums; }
    .text { text-transform: none; }
    .aux { opacity: 0.75; font-weight: 500; }
    .popover {
      position: absolute; right: 0; top: calc(100% + 8px); z-index: 20;
      display: grid; gap: 10px; width: min(340px, 90vw);
      padding: 12px; border: 1px solid var(--border-color, rgba(255,255,255,0.16));
      border-radius: 8px; background: var(--surface-elevated, #202124);
      color: var(--text-primary, #f5f5f5); box-shadow: 0 12px 32px rgba(0,0,0,0.28);
      text-align: left;
      -webkit-app-region: no-drag;
    }
    .provider-detail { display: grid; gap: 6px; }
    .provider-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .provider-title { display: grid; gap: 1px; min-width: 0; }
    .provider-heading { font-size: 0.75rem; font-weight: 700; }
    .provider-age { font-size: 0.66rem; color: var(--text-secondary, #a0a0a0); }
    .refresh-button {
      border: 1px solid color-mix(in srgb, currentColor 32%, transparent);
      border-radius: 6px; padding: 2px 7px; background: transparent; color: inherit;
      font: inherit; font-size: 0.66rem; font-weight: 650; cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .refresh-button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
    .window-row { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; font-size: 0.72rem; }
    .window-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .window-value { font-variant-numeric: tabular-nums; opacity: 0.82; }
    .bar { grid-column: 1 / -1; height: 4px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,0.12); }
    .bar-fill { display: block; height: 100%; background: currentColor; }
    .window-reset { grid-column: 1 / -1; opacity: 0.68; }
    .muted { color: var(--text-secondary, #a0a0a0); }
  `],
})
export class ProviderQuotaChipComponent implements OnInit, OnDestroy {
  private store = inject(ProviderQuotaStore);

  /** Live tick used solely to re-render the "resets in" hint each minute. */
  private readonly nowMs = signal(Date.now());
  private nowTimer: ReturnType<typeof setInterval> | null = null;
  readonly popoverOpen = signal(false);

  readonly variant = computed<QuotaChipVariant>(() => {
    if (this.store.mostConstrainedWindow()) return 'window';
    if (this.firstOkSnapshot()) return 'plan';
    return 'empty';
  });

  readonly colourBand = computed<QuotaChipBand | null>(() => {
    const w = this.store.mostConstrainedWindow();
    if (!w || w.window.limit <= 0) return null;
    const ratio = w.window.used / w.window.limit;
    if (ratio < 0.5) return 'green';
    if (ratio < 0.75) return 'yellow';
    if (ratio < 0.9) return 'orange';
    return 'red';
  });

  readonly palette = computed<{ fg: string; bg: string }>(() => {
    const band = this.colourBand();
    if (band) return BAND_COLORS[band];
    return NEUTRAL;
  });

  readonly primaryText = computed<string>(() => {
    const w = this.store.mostConstrainedWindow();
    if (w) {
      return `${PROVIDER_LABELS[w.provider]} · ${w.window.used}/${w.window.limit}`;
    }
    const ok = this.firstOkSnapshot();
    if (ok) {
      const plan = ok.plan ?? 'signed in';
      return `${PROVIDER_LABELS[ok.provider]} · ${plan}`;
    }
    return '—';
  });

  readonly secondaryText = computed<string | null>(() => {
    const w = this.store.mostConstrainedWindow();
    if (!w?.window.resetsAt) return null;
    const ms = w.window.resetsAt - this.nowMs();
    if (ms <= 0) return null;
    return `resets in ${formatDuration(ms)}`;
  });

  readonly tooltip = computed<string>(() => {
    const v = this.variant();
    if (v === 'empty') return 'No quota data yet';
    const w = this.store.mostConstrainedWindow();
    if (w) {
      return `${PROVIDER_LABELS[w.provider]} ${w.window.label}: ${w.window.used} of ${w.window.limit} ${w.window.unit}`;
    }
    const ok = this.firstOkSnapshot();
    if (ok) return `${PROVIDER_LABELS[ok.provider]} signed in (plan: ${ok.plan ?? 'unknown'})`;
    return '';
  });

  readonly stripEntries = computed(() => {
    const snaps = this.store.snapshots();
    const entries: { provider: ProviderId; code: string; value: string; percent: number }[] = [];
    for (const provider of PROVIDER_ORDER) {
      const snap = snaps[provider];
      if (!snap?.ok) continue;
      const window = this.mostUsedWindow(snap);
      if (window) {
        entries.push({
          provider,
          code: PROVIDER_CODES[provider],
          value: `${Math.round(this.windowPercent(window))}%`,
          percent: this.windowPercent(window),
        });
      } else {
        entries.push({
          provider,
          code: PROVIDER_CODES[provider],
          value: snap.plan ?? 'ok',
          percent: 0,
        });
      }
    }
    return entries;
  });

  readonly detailEntries = computed(() => {
    const snaps = this.store.snapshots();
    return PROVIDER_ORDER
      .map((provider) => {
        const snap = snaps[provider];
        if (!snap) return null;
        return {
          provider,
          label: PROVIDER_LABELS[provider],
          updatedText: formatUpdatedAge(snap.takenAt, this.nowMs()),
          status: snap.ok ? `Signed in · ${snap.plan ?? 'unknown plan'}` : (snap.error ?? 'Unavailable'),
          windows: snap.ok ? snap.windows.filter((window) => window.limit > 0) : [],
        };
      })
      .filter((entry): entry is {
        provider: ProviderId;
        label: string;
        updatedText: string;
        status: string;
        windows: ProviderQuotaWindow[];
      } => entry !== null);
  });

  ngOnInit(): void {
    void this.store.initialize();
    // Refresh "resets in" copy once a minute. Doesn't keep the loop alive.
    this.nowTimer = setInterval(() => this.nowMs.set(Date.now()), 60_000);
    if (typeof (this.nowTimer as { unref?: () => void }).unref === 'function') {
      (this.nowTimer as { unref?: () => void }).unref!();
    }
  }

  ngOnDestroy(): void {
    if (this.nowTimer) clearInterval(this.nowTimer);
  }

  togglePopover(): void {
    this.popoverOpen.update((open) => !open);
  }

  refreshProvider(provider: ProviderId): void {
    void this.store.refresh(provider);
  }

  windowPercent(window: ProviderQuotaWindow): number {
    if (window.limit <= 0) return 0;
    return Math.max(0, Math.min(100, (window.used / window.limit) * 100));
  }

  formatWindowValue(window: ProviderQuotaWindow): string {
    return `${Math.round(this.windowPercent(window))}%`;
  }

  formatReset(resetsAt: number): string {
    const ms = resetsAt - this.nowMs();
    if (ms <= 0) return 'now';
    return `in ${formatDuration(ms)}`;
  }

  /** First provider with `ok: true` snapshot, in stable order. */
  private firstOkSnapshot(): ProviderQuotaSnapshot | null {
    const snaps = this.store.snapshots();
    for (const p of PROVIDER_ORDER) {
      const s = snaps[p];
      if (s && s.ok) return s;
    }
    return null;
  }

  private mostUsedWindow(snapshot: ProviderQuotaSnapshot): ProviderQuotaWindow | null {
    let best: ProviderQuotaWindow | null = null;
    let bestPercent = -1;
    for (const window of snapshot.windows) {
      if (window.limit <= 0) continue;
      const percent = this.windowPercent(window);
      if (percent > bestPercent) {
        best = window;
        bestPercent = percent;
      }
    }
    return best;
  }
}

/** Format a positive ms duration as "1h 23m" / "47m" / "0m". */
function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatUpdatedAge(takenAt: number, now: number): string {
  const ageMs = Math.max(0, now - takenAt);
  const totalMin = Math.floor(ageMs / 60_000);
  if (totalMin < 1) return 'updated just now';
  if (totalMin < 60) return `updated ${totalMin}m ago`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) return `updated ${totalHours}h ago`;
  return `updated ${Math.floor(totalHours / 24)}d ago`;
}

const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];
const PROVIDER_CODES: Record<ProviderId, string> = {
  claude: 'CC',
  codex: 'CX',
  gemini: 'GM',
  copilot: 'CP',
  cursor: 'CU',
};
