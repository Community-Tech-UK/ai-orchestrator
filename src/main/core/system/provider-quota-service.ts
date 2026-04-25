/**
 * ProviderQuotaService — tracks remaining usage budgets exposed by each
 * underlying CLI provider (Claude 5-hour windows, Copilot monthly premium
 * caps, Anthropic per-minute rate limits, etc.).
 *
 * Holds at most one snapshot per provider; emits:
 *   - 'quota-updated'   on every snapshot store
 *   - 'quota-warning'   when a window crosses 50/75/90 %
 *   - 'quota-exhausted' when a window reaches >= 100 %
 *
 * Threshold debouncing: each (provider, windowId, threshold) tuple fires at
 * most once per "session". A "session" ends — and the suppression resets —
 * when the window's `used` value drops (window reset detected).
 *
 * Mirrors the EventEmitter + lazy-singleton pattern used by `CostTracker`.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';
import type {
  ProviderId,
  ProviderQuotaAlert,
  ProviderQuotaSnapshot,
  ProviderQuotaState,
  ProviderQuotaWindow,
  QuotaSource,
} from '../../../shared/types/provider-quota.types';

const logger = getLogger('ProviderQuotaService');

const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'copilot'];
const WARNING_THRESHOLDS: readonly number[] = [50, 75, 90];
const EXHAUSTED_THRESHOLD = 100;

/**
 * Probe contract — one implementation per provider. The service treats probes
 * as black boxes that return either a complete snapshot or null (no info).
 */
export interface ProviderQuotaProbe {
  readonly provider: ProviderId;
  probe(opts: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null>;
}

export class ProviderQuotaService extends EventEmitter {
  private snapshots = new Map<ProviderId, ProviderQuotaSnapshot | null>();
  private probes = new Map<ProviderId, ProviderQuotaProbe>();
  private timers = new Map<ProviderId, NodeJS.Timeout>();
  /** Keys: `<provider>:<windowId>:<threshold>`. Once added, suppresses re-emission. */
  private alertedKeys = new Set<string>();
  /** Last `used` value seen per (provider, windowId), for window-reset detection. */
  private lastUsed = new Map<string, number>();

  constructor() {
    super();
    for (const p of PROVIDERS) this.snapshots.set(p, null);
  }

  registerProbe(probe: ProviderQuotaProbe): void {
    this.probes.set(probe.provider, probe);
  }

  getSnapshot(provider: ProviderId): ProviderQuotaSnapshot | null {
    return this.snapshots.get(provider) ?? null;
  }

  getAll(): ProviderQuotaState {
    const out: Record<ProviderId, ProviderQuotaSnapshot | null> = {
      claude: null,
      codex: null,
      gemini: null,
      copilot: null,
    };
    for (const p of PROVIDERS) out[p] = this.snapshots.get(p) ?? null;
    return { snapshots: out };
  }

  /**
   * Cheap path: ingest a snapshot derived from per-turn adapter telemetry
   * (e.g. response headers). Caller supplies everything except `takenAt`
   * and `source`.
   */
  ingestFromAdapter(
    provider: ProviderId,
    snapshot: Omit<ProviderQuotaSnapshot, 'takenAt' | 'source'>,
    source: QuotaSource = 'header',
  ): void {
    const full: ProviderQuotaSnapshot = {
      ...snapshot,
      takenAt: Date.now(),
      source,
    };
    this.storeSnapshot(provider, full);
  }

  /** Active path: invoke the registered probe. */
  async refresh(provider: ProviderId): Promise<ProviderQuotaSnapshot | null> {
    const probe = this.probes.get(provider);
    if (!probe) {
      logger.debug(`No probe registered for ${provider}`);
      return null;
    }
    const ac = new AbortController();
    try {
      const result = await probe.probe({ signal: ac.signal });
      if (result == null) return null;
      const full: ProviderQuotaSnapshot = { ...result, takenAt: Date.now() };
      this.storeSnapshot(provider, full);
      return full;
    } catch (err) {
      const errSnap: ProviderQuotaSnapshot = {
        provider,
        takenAt: Date.now(),
        source: 'inferred',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        windows: [],
      };
      this.storeSnapshot(provider, errSnap);
      logger.warn(`Quota probe for ${provider} failed: ${errSnap.error}`);
      return errSnap;
    }
  }

  async refreshAll(): Promise<ProviderQuotaSnapshot[]> {
    const targets = PROVIDERS.filter((p) => this.probes.has(p));
    const results = await Promise.all(targets.map((p) => this.refresh(p)));
    return results.filter((r): r is ProviderQuotaSnapshot => r !== null);
  }

  /**
   * Schedule periodic refresh. `intervalMs <= 0` disables polling for this
   * provider. Calling again replaces the existing timer.
   */
  startPolling(provider: ProviderId, intervalMs: number): void {
    this.stopPolling(provider);
    if (intervalMs <= 0) return;
    // Fire one immediate refresh so the chip populates without waiting a tick.
    void this.refresh(provider);
    const t = setInterval(() => {
      void this.refresh(provider);
    }, intervalMs);
    // Don't keep the event loop alive purely for quota polling.
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(provider, t);
  }

  stopPolling(provider: ProviderId): void {
    const t = this.timers.get(provider);
    if (t) {
      clearInterval(t);
      this.timers.delete(provider);
    }
  }

  /** Test-only: undo all state and remove listeners. */
  _resetForTesting(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.probes.clear();
    this.alertedKeys.clear();
    this.lastUsed.clear();
    for (const p of PROVIDERS) this.snapshots.set(p, null);
    this.removeAllListeners();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private storeSnapshot(provider: ProviderId, snapshot: ProviderQuotaSnapshot): void {
    this.snapshots.set(provider, snapshot);
    this.detectWindowResets(provider, snapshot);
    this.emit('quota-updated', snapshot);
    if (snapshot.ok) this.checkThresholds(provider, snapshot);
  }

  private detectWindowResets(
    provider: ProviderId,
    snapshot: ProviderQuotaSnapshot,
  ): void {
    for (const w of snapshot.windows) {
      const memoKey = `${provider}:${w.id}`;
      const prev = this.lastUsed.get(memoKey);
      if (prev !== undefined && w.used < prev) {
        // Window reset — clear all alert keys for this (provider, window).
        const prefix = `${provider}:${w.id}:`;
        for (const k of [...this.alertedKeys]) {
          if (k.startsWith(prefix)) this.alertedKeys.delete(k);
        }
      }
      this.lastUsed.set(memoKey, w.used);
    }
  }

  private checkThresholds(
    provider: ProviderId,
    snapshot: ProviderQuotaSnapshot,
  ): void {
    for (const w of snapshot.windows) {
      if (w.limit <= 0) continue;
      const pct = (w.used / w.limit) * 100;

      if (pct >= EXHAUSTED_THRESHOLD) {
        const key = `${provider}:${w.id}:${EXHAUSTED_THRESHOLD}`;
        if (!this.alertedKeys.has(key)) {
          this.alertedKeys.add(key);
          this.emit('quota-exhausted', this.makeAlert(provider, w, EXHAUSTED_THRESHOLD));
        }
        // When exhausted, don't double-emit the lower warnings as well —
        // the UI promotes the single 'exhausted' event into the strongest signal.
        continue;
      }

      for (const t of WARNING_THRESHOLDS) {
        if (pct < t) continue;
        const key = `${provider}:${w.id}:${t}`;
        if (this.alertedKeys.has(key)) continue;
        this.alertedKeys.add(key);
        this.emit('quota-warning', this.makeAlert(provider, w, t));
      }
    }
  }

  private makeAlert(
    provider: ProviderId,
    window: ProviderQuotaWindow,
    threshold: number,
  ): ProviderQuotaAlert {
    return { provider, window, threshold, timestamp: Date.now() };
  }
}

// Lazy singleton — same pattern as cost-tracker.ts.
let providerQuotaInstance: ProviderQuotaService | null = null;

export function getProviderQuotaService(): ProviderQuotaService {
  if (!providerQuotaInstance) {
    providerQuotaInstance = new ProviderQuotaService();
  }
  return providerQuotaInstance;
}
