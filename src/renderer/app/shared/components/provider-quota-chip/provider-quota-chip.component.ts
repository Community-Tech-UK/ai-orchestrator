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
};

@Component({
  selector: 'app-provider-quota-chip',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="chip"
      [class.window]="variant() === 'window'"
      [class.plan]="variant() === 'plan'"
      [class.empty]="variant() === 'empty'"
      [style.color]="palette().fg"
      [style.background]="palette().bg"
      [title]="tooltip()"
    >
      <span class="dot" [style.background]="palette().fg"></span>
      <span class="text">{{ primaryText() }}</span>
      @if (secondaryText()) {
        <span class="aux">· {{ secondaryText() }}</span>
      }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 10px 2px 8px; border-radius: 999px;
      font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em;
      white-space: nowrap; cursor: default;
      transition: all var(--transition-normal, 0.2s);
    }
    .chip.empty { font-weight: 500; opacity: 0.85; }
    .dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .text { text-transform: none; }
    .aux { opacity: 0.75; font-weight: 500; }
  `],
})
export class ProviderQuotaChipComponent implements OnInit, OnDestroy {
  private store = inject(ProviderQuotaStore);

  /** Live tick used solely to re-render the "resets in" hint each minute. */
  private readonly nowMs = signal(Date.now());
  private nowTimer: ReturnType<typeof setInterval> | null = null;

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

  /** First provider with `ok: true` snapshot, in stable order. */
  private firstOkSnapshot(): ProviderQuotaSnapshot | null {
    const snaps = this.store.snapshots();
    const order: ProviderId[] = ['claude', 'codex', 'gemini', 'copilot'];
    for (const p of order) {
      const s = snaps[p];
      if (s && s.ok) return s;
    }
    return null;
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
