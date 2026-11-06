/**
 * ProviderQuotaChipComponent
 *
 * Compact pill that surfaces the most-constrained provider quota in the app.
 *
 * Display modes (chosen automatically):
 *   • 'window' — at least one provider has numerical windows. Shows the worst
 *     window's used/limit and a "resets in Xd Yh Zm" hint, colour-banded by ratio.
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
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { copyFor } from '../../tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../tooltip/aio-tooltip.directive';
import { ProviderQuotaStore } from '../../../core/state/provider-quota.store';
import { ProviderAccountIpcService } from '../../../core/services/ipc/provider-account-ipc.service';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';
import { formatQuotaAmount } from '../../../../../shared/util/provider-quota-format';
import { accountFamilyName } from '../../../../../shared/display-names';
import {
  LEGACY_SECTION_ID,
  quotaAccountSections,
  type QuotaAccountProfile,
  type QuotaAccountSection,
} from '../../../../../shared/utils/provider-quota-account-sections';
import {
  BAND_COLORS,
  quotaStripEntry,
  windowPercent,
  type QuotaChipBand,
  type QuotaStripEntry,
} from './provider-quota-strip';

export type QuotaChipVariant = 'window' | 'plan' | 'empty';
export type { QuotaChipBand };

interface QuotaDetailSection {
  id: string;
  label: string | null;
  /** Who is signed out: the account's own name, or the provider when it has one account. */
  signedOutName: string;
  updatedText: string;
  status: string;
  needsReauth: boolean;
  /** The probe's own instruction or the shell command that signs in again. Shown only under Details. */
  reauthHint: string | null;
  windows: ProviderQuotaWindow[];
}

interface QuotaDetailEntry {
  provider: ProviderId;
  label: string;
  updatedText: string;
  sections: QuotaDetailSection[];
}

const NEUTRAL = { fg: '#9a9aa0', bg: 'rgba(154,154,160,0.10)' };

@Component({
  selector: 'app-provider-quota-chip',
  standalone: true,
  imports: [CommonModule, AioTooltipDirective],
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
        [appTooltip]="tooltip()"
        [attr.aria-expanded]="popoverOpen()"
        aria-label="Provider quota details"
        (click)="togglePopover()"
      >
        <span class="dot" [style.background]="palette().fg"></span>
        <span class="strip" data-testid="quota-strip">
          @if (stripEntries().length > 0) {
            @for (entry of stripEntries(); track entry.provider) {
              <span class="provider-entry" [style.color]="entry.fg">
                <span class="provider-name">{{ entry.name }}</span>{{ ' ' }}<span class="provider-value">{{ entry.text }}</span>
                @if (pacingProvider() === entry.provider) {
                  <svg
                    class="pacing-badge"
                    [attr.data-testid]="'quota-pacing-' + entry.provider"
                    aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                    stroke-linecap="round" stroke-linejoin="round"
                  >
                    <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z"/>
                  </svg>
                }
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
              @for (section of provider.sections; track section.id) {
                <span
                  class="account-rows"
                  [attr.data-testid]="section.label ? 'quota-account-' + provider.provider + '-' + section.id : null"
                >
                  @if (section.label) {
                    <span class="account-heading">
                      <span class="window-label account-label">Account: {{ section.label }}</span>
                      <span class="account-age">{{ section.updatedText }}</span>
                    </span>
                  }
                  @if (section.needsReauth) {
                    <span
                      class="reauth-row"
                      [attr.data-testid]="section.id === 'legacy' ? 'quota-reauth-row-' + provider.provider : 'quota-reauth-row-' + provider.provider + '-' + section.id"
                    >
                      <span class="reauth-main">
                        <span class="reauth-text">Signed out of {{ section.signedOutName }}.</span>
                        <button
                          type="button"
                          class="reauth-action"
                          [attr.data-testid]="section.id === 'legacy' ? 'quota-reauth-' + provider.provider : 'quota-reauth-' + provider.provider + '-' + section.id"
                          [appTooltip]="reauthActionTitle(provider.provider)"
                          (click)="openAccounts(provider.provider)"
                        >Sign in</button>
                      </span>
                      @if (section.reauthHint) {
                        <details class="reauth-details" data-testid="quota-reauth-details">
                          <summary>Details</summary>
                          <span class="reauth-hint">{{ section.reauthHint }}</span>
                        </details>
                      }
                    </span>
                  }
                  @for (window of section.windows; track window.id) {
                    <span class="window-row">
                      <span class="window-label">{{ window.label }}</span>
                      <span class="window-value">{{ formatWindowValue(window) }}</span>
                      <span class="bar"><span class="bar-fill" [style.width.%]="windowPercent(window)"></span></span>
                      @if (window.resetsAt) {
                        <span class="window-reset">resets {{ formatReset(window.resetsAt) }}</span>
                      }
                    </span>
                  } @empty {
                    @if (!section.needsReauth) {
                      <span class="window-row muted">{{ section.status }}</span>
                    }
                  }
                </span>
              }
            </span>
          }
        </span>
      }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; position: relative; min-width: 0; }
    .quota-shell { display: inline-flex; position: relative; min-width: 0; max-width: 100%; }
    .chip {
      display: inline-flex; align-items: center; gap: 6px; min-width: 0;
      padding: 5px 10px 5px 8px; border-radius: 999px; border: 0;
      font: inherit; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0;
      white-space: nowrap; cursor: pointer;
      max-width: min(46vw, 560px);
      -webkit-app-region: no-drag;
      transition: all var(--transition-normal, 0.2s);
    }
    .strip { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow-x: auto; }
    .chip.open { box-shadow: 0 0 0 1px currentColor; }
    .chip.empty { font-weight: 500; opacity: 0.85; }
    .dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    }
    .provider-entry { display: inline-flex; align-items: baseline; gap: 4px; }
    .provider-name { font-weight: 700; }
    .provider-value { opacity: 0.82; font-variant-numeric: tabular-nums; }
    .pacing-badge { width: 11px; height: 11px; color: #f6c453; flex-shrink: 0; }
    .text { text-transform: none; }
    .account-rows { display: contents; }
    .account-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; font-size: 0.72rem; }
    .account-label { font-weight: 600; opacity: 0.9; }
    .account-age { flex-shrink: 0; font-size: 0.66rem; color: var(--text-secondary, #a0a0a0); }
    .aux { opacity: 0.75; font-weight: 500; }
    .popover {
      position: absolute; right: 0; top: calc(100% + 8px); z-index: 20;
      display: grid; gap: 10px; width: min(380px, 90vw); max-height: min(70vh, 560px);
      overflow-y: auto;
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
    .reauth-row {
      display: grid; gap: 4px;
      font-size: 0.7rem; line-height: 1.3;
      padding: 4px 7px; border-radius: 6px;
      background: rgba(239,68,68,0.10);
      border: 1px solid rgba(239,68,68,0.28);
    }
    .reauth-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .reauth-text { font-weight: 600; color: #f6c453; }
    .reauth-action {
      flex-shrink: 0; font: inherit; font-size: 0.66rem; font-weight: 650; cursor: pointer;
      padding: 2px 8px; border-radius: 6px; color: inherit; background: transparent;
      border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    }
    .reauth-action:hover { background: rgba(239,68,68,0.18); }
    .reauth-action:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    .reauth-details summary { cursor: pointer; font-size: 0.66rem; color: var(--text-secondary, #a0a0a0); }
    .reauth-hint { display: block; margin-top: 3px; color: var(--text-secondary, #a0a0a0); overflow-wrap: anywhere; }
  `],
})
export class ProviderQuotaChipComponent implements OnInit, OnDestroy {
  private store = inject(ProviderQuotaStore);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Live tick used solely to re-render the "resets in" hint each minute. */
  private readonly nowMs = signal(Date.now());
  private readonly accountIpc = inject(ProviderAccountIpcService);
  /** Account profiles (labels, order, enabled state); null until loaded. */
  private readonly accountProfiles = signal<QuotaAccountProfile[] | null>(null);
  private nowTimer: ReturnType<typeof setInterval> | null = null;
  readonly popoverOpen = signal(false);
  /** Emitted when a "Reauth needed" banner is clicked; the app opens that provider's accounts page. */
  readonly accountsRequested = output<ProviderId>();

  constructor() {
    effect(() => {
      const ids = this.store.accountSnapshots()
        .map((entry) => `${entry.provider}:${entry.accountProfileId ?? ''}`)
        .sort()
        .join(',');
      if (!ids) return;
      void this.loadAccountProfiles();
    });
  }

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

  /** Provider with the most recent early pacing warning, if it remains visible. */
  readonly pacingProvider = computed<ProviderId | null>(() => {
    const warning = this.store.lastPacingWarning();
    if (!warning) return null;
    const currentWindow = this.accountSections(warning.provider)
      .flatMap((section) => section.snapshot.windows)
      .find((window) => window.id === warning.window.id);
    if (
      !currentWindow
      || currentWindow.limit <= 0
      || (currentWindow.used / currentWindow.limit) * 100 < warning.utilizationThresholdPercent
    ) {
      return null;
    }
    return warning.provider;
  });

  readonly primaryText = computed<string>(() => {
    const w = this.store.mostConstrainedWindow();
    if (w) {
      return `${accountFamilyName(w.provider)} · ${formatQuotaAmount(w.window.used)}/${formatQuotaAmount(w.window.limit)}`;
    }
    const ok = this.firstOkSnapshot();
    if (ok) {
      const plan = ok.plan ?? 'signed in';
      return `${accountFamilyName(ok.provider)} · ${plan}`;
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

  /** The pacing warning is explained here; the strip only shows its bolt so the bar stays one line. */
  readonly tooltip = computed<string>(() => {
    const summary = this.quotaSummary();
    const pacing = this.pacingProvider();
    if (!pacing) return summary;
    const warning = `${accountFamilyName(pacing)}: ${copyFor('shell.quotaPacing')}`;
    return summary ? `${summary}\n${warning}` : warning;
  });

  private readonly quotaSummary = computed<string>(() => {
    const v = this.variant();
    if (v === 'empty') return 'No quota data yet';
    const w = this.store.mostConstrainedWindow();
    if (w) {
      const amount = w.window.unit === 'percent'
        ? `${formatQuotaAmount(w.window.used)}% used`
        : `${formatQuotaAmount(w.window.used)} of ${formatQuotaAmount(w.window.limit)} ${w.window.unit}`;
      const sections = this.accountSections(w.provider);
      const account = sections.find((section) =>
        section.id === (w.accountProfileId ?? LEGACY_SECTION_ID))?.label ?? w.accountProfileId ?? null;
      const pool = sections.length > 1 ? ` · ${sections.length} accounts` : '';
      return `${accountFamilyName(w.provider)}${account ? ` (${account})` : ''}${pool}: ${w.window.label}: ${amount}`;
    }
    const ok = this.firstOkSnapshot();
    if (ok) return `${accountFamilyName(ok.provider)} signed in (plan: ${ok.plan ?? 'unknown'})`;
    return '';
  });

  /**
   * One entry per provider: its short name and the worst percentage across its
   * accounts ("Claude 100%"). Each account's own figure, under its own name, is
   * in the popover.
   */
  readonly stripEntries = computed<QuotaStripEntry[]>(() => {
    const snaps = this.store.snapshots();
    const entries: QuotaStripEntry[] = [];
    for (const provider of PROVIDER_ORDER) {
      // A missing CLI, or a provider whose quota doesn't apply under the
      // current config (LT-650), means "nothing to show" — hide it rather
      // than rendering an error/plan row.
      if (snaps[provider]?.cliNotInstalled || snaps[provider]?.notApplicable) continue;
      const entry = quotaStripEntry(provider, this.accountSections(provider));
      if (entry) entries.push(entry);
    }
    return entries;
  });

  readonly detailEntries = computed<QuotaDetailEntry[]>(() => {
    const snaps = this.store.snapshots();
    const now = this.nowMs();
    const entries: QuotaDetailEntry[] = [];
    for (const provider of PROVIDER_ORDER) {
      // Providers whose CLI isn't installed, or whose quota doesn't apply
      // under the current config (LT-650), are hidden from the popover.
      if (snaps[provider]?.cliNotInstalled || snaps[provider]?.notApplicable) continue;
      const sections = this.accountSections(provider);
      if (sections.length === 0) continue;
      const newest = Math.max(...sections.map((section) => section.snapshot.takenAt));
      entries.push({
        provider,
        label: accountFamilyName(provider),
        updatedText: formatUpdatedAge(snaps[provider]?.takenAt ?? newest, now),
        sections: sections.map((section) => detailSection(provider, section, now)),
      });
    }
    return entries;
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
    if (this.popoverOpen() && this.store.accountSnapshots().length > 0) void this.loadAccountProfiles();
  }

  /**
   * Every reauth banner is the entry point to sign in again: it closes the
   * popover and asks the app to open the accounts page that owns this
   * provider's sign-in.
   */
  openAccounts(provider: ProviderId): void {
    this.popoverOpen.set(false);
    this.accountsRequested.emit(provider);
  }

  reauthActionTitle(provider: ProviderId): string {
    return provider === 'copilot'
      ? copyFor('shell.copilotAccountsSignIn')
      : copyFor('shell.accountsSignIn');
  }

  private async loadAccountProfiles(): Promise<void> {
    try {
      const { profiles } = await this.accountIpc.list();
      this.accountProfiles.set(profiles);
    } catch {
      // Keep the last known list. Without one, every account snapshot is
      // still shown, identified by its profile id.
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.popoverOpen()) return;
    const target = event.target;
    if (target instanceof Node && this.elementRef.nativeElement.contains(target)) return;
    this.popoverOpen.set(false);
  }

  refreshProvider(provider: ProviderId): void {
    void this.store.refresh(provider);
  }

  windowPercent(window: ProviderQuotaWindow): number {
    return windowPercent(window);
  }

  formatWindowValue(window: ProviderQuotaWindow): string {
    return `${Math.round(this.windowPercent(window))}%`;
  }

  formatReset(resetsAt: number): string {
    const ms = resetsAt - this.nowMs();
    if (ms <= 0) return 'now';
    return `in ${formatDuration(ms)}`;
  }

  private accountSections(provider: ProviderId): QuotaAccountSection[] {
    return quotaAccountSections(
      provider,
      this.store.snapshots()[provider],
      this.store.accountSnapshots(),
      this.accountProfiles(),
    );
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

}

/** Format a positive ms duration as "1d 2h 3m" / "1h 23m" / "47m" / "0m". */
function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function detailSection(provider: ProviderId, section: QuotaAccountSection, now: number): QuotaDetailSection {
  const snap = section.snapshot;
  const needsReauth = snap.needsReauth === true;
  return {
    id: section.id,
    label: section.label,
    signedOutName: section.label ?? accountFamilyName(provider),
    updatedText: formatUpdatedAge(snap.takenAt, now),
    status: snap.ok ? `Signed in · ${snap.plan ?? 'unknown plan'}` : (snap.error ?? 'Unavailable'),
    needsReauth,
    // The probe's error string is already the actionable instruction; fall
    // back to a per-provider hint when it isn't present. Either way it is shell
    // commands and developer wording, so the popover keeps it under Details.
    reauthHint: needsReauth ? (snap.error ?? PROVIDER_REAUTH_HINTS[provider]) : null,
    windows: snap.windows.filter((window) => window.limit > 0 && (snap.ok || snap.needsReauth)),
  };
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

const PROVIDER_ORDER: ProviderId[] = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'];
/** Fallback sign-in instruction when a probe didn't supply its own. Shown only under "Details". */
const PROVIDER_REAUTH_HINTS: Record<ProviderId, string> = {
  claude: 'Run `claude` to sign in again',
  codex: 'Run `codex login` to sign in again',
  gemini: 'Run `gemini` to sign in again',
  antigravity: 'Run `agy` (or `gemini`) to sign in again',
  copilot: 'Run `gh auth login` to sign in again',
  cursor: 'Open Cursor and sign in to refresh the session',
  grok: 'Run `grok login` (or set XAI_API_KEY) to sign in again',
  opencode: 'Click Refresh to renew the session via Xiaomi SSO, or sign in to the MiMo console in Chrome',
};
