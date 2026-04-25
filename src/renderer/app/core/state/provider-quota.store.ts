/**
 * ProviderQuotaStore — signal-backed renderer state for provider quota
 * snapshots (Claude 5h/weekly windows, Copilot monthly premium, etc.).
 *
 * Mirrors the snapshot held by the main-process `ProviderQuotaService`,
 * subscribes to push events, and exposes computed selectors for the UI
 * (per-provider snapshot, most-constrained window across providers).
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { QuotaIpcService } from '../services/ipc/quota-ipc.service';
import type {
  ProviderId,
  ProviderQuotaAlert,
  ProviderQuotaSnapshot,
  ProviderQuotaState,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';

const EMPTY_STATE: ProviderQuotaState = {
  snapshots: { claude: null, codex: null, gemini: null, copilot: null },
};

/** localStorage key for persisted per-provider poll intervals. */
const POLL_PREFS_KEY = 'provider-quota.poll-intervals.v1';

@Injectable({ providedIn: 'root' })
export class ProviderQuotaStore {
  private ipc = inject(QuotaIpcService);

  // ─── state ───────────────────────────────────────────────────────────────

  private _state = signal<ProviderQuotaState>(EMPTY_STATE);
  /** Most recent threshold-warning event (50/75/90 %). Null until observed. */
  private _lastWarning = signal<ProviderQuotaAlert | null>(null);
  /** Most recent exhaustion event (>=100 %). Null until observed. */
  private _lastExhausted = signal<ProviderQuotaAlert | null>(null);
  private _initialized = signal(false);
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  /** Push-event unsubscribers, recorded on initialize() so we can detach later. */
  private unsubs: (() => void)[] = [];

  // ─── selectors ───────────────────────────────────────────────────────────

  readonly snapshots = computed(() => this._state().snapshots);
  readonly initialized = this._initialized.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly lastWarning = this._lastWarning.asReadonly();
  readonly lastExhausted = this._lastExhausted.asReadonly();

  /** Most-constrained window across all providers. Drives the global chip. */
  readonly mostConstrainedWindow = computed<{
    provider: ProviderId;
    window: ProviderQuotaWindow;
  } | null>(() => {
    const snaps = this._state().snapshots;
    let worst: { provider: ProviderId; window: ProviderQuotaWindow; ratio: number } | null = null;
    for (const provider of Object.keys(snaps) as ProviderId[]) {
      const snap = snaps[provider];
      if (!snap || !snap.ok) continue;
      for (const w of snap.windows) {
        if (w.limit <= 0) continue;
        const ratio = w.used / w.limit;
        if (!worst || ratio > worst.ratio) {
          worst = { provider, window: w, ratio };
        }
      }
    }
    return worst ? { provider: worst.provider, window: worst.window } : null;
  });

  /** Returns the snapshot signal for a single provider (memoised by call site). */
  snapshotFor(provider: ProviderId) {
    return computed(() => this._state().snapshots[provider]);
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Pull the current state from the main process and subscribe to push events.
   * Idempotent — calling again is a no-op.
   *
   * After the initial state arrives, kicks off a one-shot `refreshAll()` in
   * the background so the chip lights up with live data without the UI
   * having to wait for it. Push events update the store as snapshots arrive.
   */
  async initialize(): Promise<void> {
    if (this._initialized()) return;
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.quotaGetAll();
      if (response.success && response.data) {
        this._state.set(response.data as ProviderQuotaState);
      } else {
        const msg = response.error?.message ?? 'Failed to load quota state';
        this._error.set(msg);
      }
      this.attachListeners();
      this._initialized.set(true);
      // Re-apply any persisted poll-interval prefs (the main-process service
      // doesn't survive app restarts, so we restore from localStorage here).
      const persisted = this.readPollIntervals();
      for (const provider of Object.keys(persisted) as ProviderId[]) {
        const ms = persisted[provider];
        if (ms > 0) {
          void this.ipc.quotaSetPollInterval(provider, ms).catch(() => {
            /* non-fatal — user can re-toggle from settings */
          });
        }
      }
      // Fire-and-forget: kicks every registered probe in parallel.
      // Snapshots arrive via the QUOTA_UPDATED push event, which is already
      // wired by `attachListeners()` above, so we don't need to await this.
      void this.ipc.quotaRefreshAll().catch(() => { /* surfaced via probe error snapshot */ });
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /** Force a fresh probe for one provider. */
  async refresh(provider: ProviderId): Promise<void> {
    const response = await this.ipc.quotaRefresh(provider);
    if (response.success && response.data) {
      this.applySnapshot(response.data as ProviderQuotaSnapshot);
    }
  }

  /** Force a fresh probe for every provider with a registered probe. */
  async refreshAll(): Promise<void> {
    const response = await this.ipc.quotaRefreshAll();
    if (response.success && Array.isArray(response.data)) {
      for (const snap of response.data as ProviderQuotaSnapshot[]) {
        this.applySnapshot(snap);
      }
    }
  }

  /**
   * Configure auto-refresh cadence for one provider. 0 = disabled.
   * Persists to localStorage so the choice survives an app restart; the main
   * process forgets timers on shutdown, so the store re-applies on init.
   */
  async setPollInterval(provider: ProviderId, intervalMs: number): Promise<void> {
    await this.ipc.quotaSetPollInterval(provider, intervalMs);
    this.persistPollInterval(provider, intervalMs);
  }

  /** Read the saved poll-interval map (from localStorage). */
  readPollIntervals(): Record<ProviderId, number> {
    const def: Record<ProviderId, number> = { claude: 0, codex: 0, gemini: 0, copilot: 0 };
    if (typeof window === 'undefined' || !window.localStorage) return def;
    try {
      const raw = window.localStorage.getItem(POLL_PREFS_KEY);
      if (!raw) return def;
      const parsed = JSON.parse(raw) as Partial<Record<ProviderId, number>>;
      return {
        claude: typeof parsed.claude === 'number' ? parsed.claude : 0,
        codex: typeof parsed.codex === 'number' ? parsed.codex : 0,
        gemini: typeof parsed.gemini === 'number' ? parsed.gemini : 0,
        copilot: typeof parsed.copilot === 'number' ? parsed.copilot : 0,
      };
    } catch {
      return def;
    }
  }

  private persistPollInterval(provider: ProviderId, intervalMs: number): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const current = this.readPollIntervals();
      current[provider] = intervalMs;
      window.localStorage.setItem(POLL_PREFS_KEY, JSON.stringify(current));
    } catch {
      // Storage failures are non-fatal — runtime state is still correct.
    }
  }

  /** Detach push-event subscriptions. Mainly for tests / app teardown. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this._initialized.set(false);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private attachListeners(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(
      this.ipc.onQuotaUpdated((data) => {
        const snap = data as ProviderQuotaSnapshot;
        this.applySnapshot(snap);
      }),
      this.ipc.onQuotaWarning((data) => {
        this._lastWarning.set(data as ProviderQuotaAlert);
      }),
      this.ipc.onQuotaExhausted((data) => {
        this._lastExhausted.set(data as ProviderQuotaAlert);
      }),
    );
  }

  private applySnapshot(snap: ProviderQuotaSnapshot): void {
    this._state.update((s) => ({
      snapshots: { ...s.snapshots, [snap.provider]: snap },
    }));
  }
}
