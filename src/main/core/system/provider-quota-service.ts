/**
 * ProviderQuotaService — tracks remaining usage budgets exposed by each
 * underlying CLI provider (Claude 5-hour windows, Copilot monthly premium
 * caps, Anthropic per-minute rate limits, etc.).
 *
 * Holds at most one snapshot per provider; emits:
 *   - 'quota-updated'   on every snapshot store
 *   - 'quota-warning'   when a window crosses 50/75/90 %
 *   - 'quota-pacing-warning' when a known-duration window is consumed ahead
 *     of its elapsed time budget
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
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { classifyLoopError } from '../loop-error-classification';
import { retryWithBackoff } from '../../util/backoff';
import type {
  ProviderId,
  ProviderQuotaAlert,
  ProviderQuotaPacingAlert,
  ProviderQuotaSnapshot,
  ProviderQuotaState,
  ProviderQuotaWindow,
  QuotaSource,
} from '../../../shared/types/provider-quota.types';
import { providerQuotaKey } from '../../../shared/types/provider-quota.types';

const logger = getLogger('ProviderQuotaService');

const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok'];
const WARNING_THRESHOLDS: readonly number[] = [50, 75, 90];
const EXHAUSTED_THRESHOLD = 100;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_PROBE_ATTEMPTS = 2;

export interface QuotaPacingConfig {
  enabled: boolean;
  utilizationThresholdPercent: number;
  latestElapsedPercent: number;
}

export const DEFAULT_QUOTA_PACING_CONFIG: Readonly<QuotaPacingConfig> = Object.freeze({
  enabled: true,
  utilizationThresholdPercent: 90,
  latestElapsedPercent: 72,
});

/**
 * Probe contract — one implementation per provider. The service treats probes
 * as black boxes that return either a complete snapshot or null (no info).
 */
export interface ProviderQuotaProbe {
  readonly provider: ProviderId;
  /** Account-pool profile the probe reads. Absent for the legacy/provider-level probe. */
  readonly accountProfileId?: string;
  /**
   * When true, the probe's snapshots are stored and shown but never raise
   * warning, exhausted or pacing alerts (e.g. a disabled pool account).
   */
  readonly silenceAlerts?: boolean;
  /**
   * `force` asks a throttled probe to run now anyway: a decision (an account
   * switch) is about to act on the answer.
   */
  probe(opts: { signal: AbortSignal; force?: boolean }): Promise<ProviderQuotaSnapshot | null>;
}

/**
 * Reports whether the provider's CLI binary is installed on this machine.
 * Injected at wiring time (see `registerDefaultQuotaProbes`) so the service
 * itself stays free of a dependency on the CLI-detection subsystem — and so
 * unit tests that construct the service directly keep the old behaviour
 * (no check → every provider is probed).
 */
export type CliInstalledCheck = (provider: ProviderId) => Promise<boolean>;

export class ProviderQuotaService extends EventEmitter {
  private snapshots = new Map<ProviderId, ProviderQuotaSnapshot | null>();
  /** Non-legacy account-pool profile snapshots, keyed `provider:profileId`. */
  private accountSnapshots = new Map<string, ProviderQuotaSnapshot>();
  /** Keyed by {@link providerQuotaKey}. */
  private probes = new Map<string, ProviderQuotaProbe>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Low-frequency whole-fleet poll so windows stay fresh even when idle. */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Keys: `<provider>:<windowId>:<threshold>`. Once added, suppresses re-emission. */
  private alertedKeys = new Set<string>();
  /** One early-pacing warning per provider/window lifecycle. */
  private pacingAlertedKeys = new Set<string>();
  /** Last `used` value seen per (provider, windowId), for window-reset detection. */
  private lastUsed = new Map<string, number>();
  private isPaused = getPauseCoordinator().isPaused();
  private activeAborters = new Set<AbortController>();
  /** When set, refresh() skips probing providers whose CLI is not installed. */
  private cliInstalledCheck: CliInstalledCheck | null = null;
  private pacingConfig: QuotaPacingConfig = { ...DEFAULT_QUOTA_PACING_CONFIG };
  private readonly handlePause = (): void => {
    this.isPaused = true;
    for (const aborter of this.activeAborters) aborter.abort();
  };
  private readonly handleResume = (): void => {
    this.isPaused = false;
  };

  constructor() {
    super();
    for (const p of PROVIDERS) this.snapshots.set(p, null);
    const pauseCoordinator = getPauseCoordinator();
    pauseCoordinator.on('pause', this.handlePause);
    pauseCoordinator.on('resume', this.handleResume);
  }

  registerProbe(probe: ProviderQuotaProbe): void {
    this.probes.set(providerQuotaKey(probe.provider, probe.accountProfileId), probe);
  }

  /** Drop every non-legacy account probe (and its polling) for a provider, before re-registering. */
  unregisterAccountProbes(provider: ProviderId): void {
    for (const [key, probe] of [...this.probes]) {
      if (probe.provider === provider && probe.accountProfileId && probe.accountProfileId !== 'legacy') {
        this.probes.delete(key);
        this.stopPolling(provider, probe.accountProfileId);
      }
    }
  }

  /** Install (or clear, with null) the CLI-installed gate used by refresh(). */
  setCliInstalledCheck(check: CliInstalledCheck | null): void {
    this.cliInstalledCheck = check;
  }

  /** Update the operator-controlled early quota-pacing thresholds. */
  configurePacing(config: Partial<QuotaPacingConfig>): void {
    const next: QuotaPacingConfig = {
      ...this.pacingConfig,
      ...config,
    };
    if (
      !Number.isFinite(next.utilizationThresholdPercent)
      || next.utilizationThresholdPercent < 0
      || next.utilizationThresholdPercent > 100
      || !Number.isFinite(next.latestElapsedPercent)
      || next.latestElapsedPercent < 0
      || next.latestElapsedPercent > 100
    ) {
      throw new Error('Quota pacing thresholds must be finite percentages from 0 to 100');
    }
    this.pacingConfig = next;
    this.pacingAlertedKeys.clear();
  }

  getSnapshot(provider: ProviderId, accountProfileId?: string | null): ProviderQuotaSnapshot | null {
    const key = providerQuotaKey(provider, accountProfileId);
    return key === provider ? this.snapshots.get(provider) ?? null : this.accountSnapshots.get(key) ?? null;
  }

  getAll(): ProviderQuotaState {
    const out: Record<ProviderId, ProviderQuotaSnapshot | null> = {
      claude: null,
      codex: null,
      gemini: null,
      antigravity: null,
      copilot: null,
      cursor: null,
      grok: null,
    };
    for (const p of PROVIDERS) out[p] = this.snapshots.get(p) ?? null;
    return this.accountSnapshots.size > 0
      ? { snapshots: out, accountSnapshots: [...this.accountSnapshots.values()] }
      : { snapshots: out };
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
    accountProfileId?: string | null,
  ): void {
    const full: ProviderQuotaSnapshot = {
      ...snapshot,
      takenAt: Date.now(),
      source,
    };
    this.storeSnapshot(provider, full, accountProfileId);
  }

  /** Active path: invoke the registered probe. `force` bypasses a probe's own throttle. */
  async refresh(
    provider: ProviderId,
    accountProfileId?: string | null,
    opts: { force?: boolean } = {},
  ): Promise<ProviderQuotaSnapshot | null> {
    if (this.isPaused || getPauseCoordinator().isPaused()) {
      return null;
    }

    const probeKey = providerQuotaKey(provider, accountProfileId);
    const probe = this.probes.get(probeKey);
    if (!probe) {
      logger.debug(`No probe registered for ${probeKey}`);
      return null;
    }

    // Don't surface quota for CLIs that aren't installed on this machine —
    // credential files or a shared usage-monitor snapshot could still produce
    // numbers, which is misleading. Store a marker snapshot (rather than
    // clearing to null) so the renderer's push-event flow replaces any stale
    // data and the UI can hide the provider. Fail open on check errors.
    if (this.cliInstalledCheck) {
      let installed = true;
      try {
        installed = await this.cliInstalledCheck(provider);
      } catch (err) {
        logger.debug(`CLI-installed check for ${provider} failed — probing anyway`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!installed) {
        const notInstalled: ProviderQuotaSnapshot = {
          provider,
          takenAt: Date.now(),
          source: 'inferred',
          ok: false,
          error: 'CLI not installed',
          cliNotInstalled: true,
          windows: [],
        };
        this.storeSnapshot(provider, notInstalled, accountProfileId);
        return notInstalled;
      }
    }

    const ac = new AbortController();
    this.activeAborters.add(ac);
    try {
      const result = await retryWithBackoff(
        () => probe.probe({ signal: ac.signal, ...(opts.force ? { force: true } : {}) }),
        {
          attempts: QUOTA_PROBE_ATTEMPTS,
          signal: ac.signal,
          classify: (error) => classifyLoopError(error, { provider }).category,
          onRetry: ({ attempt, category, delayMs }) => {
            logger.debug('Retrying transient provider quota probe', {
              provider,
              attempt,
              category,
              delayMs,
            });
          },
        },
      );
      if (result == null) return null;
      const full: ProviderQuotaSnapshot = {
        ...result,
        takenAt: result.takenAt > 0 ? result.takenAt : Date.now(),
      };
      this.storeSnapshot(provider, full, accountProfileId);
      return this.getSnapshot(provider, accountProfileId);
    } catch (err) {
      if (ac.signal.aborted && (this.isPaused || getPauseCoordinator().isPaused())) {
        return null;
      }

      const errSnap: ProviderQuotaSnapshot = {
        provider,
        takenAt: Date.now(),
        source: 'inferred',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        windows: [],
      };
      this.storeSnapshot(provider, errSnap, accountProfileId);
      logger.warn(`Quota probe for ${probeKey} failed: ${errSnap.error}`);
      return this.getSnapshot(provider, accountProfileId);
    } finally {
      this.activeAborters.delete(ac);
    }
  }

  async refreshAll(): Promise<ProviderQuotaSnapshot[]> {
    const targets = [...this.probes.values()];
    const results = await Promise.all(targets.map((probe) => this.refresh(probe.provider, probe.accountProfileId)));
    return results.filter((r): r is ProviderQuotaSnapshot => r !== null);
  }

  /**
   * Refresh the provider-level probe and every pool-account probe for that
   * provider. The title-bar chip's per-provider Refresh uses this so a second
   * Claude/Codex account is not left stale.
   */
  async refreshProviderFamily(provider: ProviderId): Promise<ProviderQuotaSnapshot | null> {
    const probes = [...this.probes.values()].filter((probe) => probe.provider === provider);
    if (probes.length === 0) return this.refresh(provider);
    const results = await Promise.all(probes.map((probe) => this.refresh(probe.provider, probe.accountProfileId)));
    return results.find((snap) => snap && !snap.accountProfileId) ?? results.find((snap) => snap) ?? null;
  }

  /**
   * Schedule periodic refresh. `intervalMs <= 0` disables polling for this
   * provider. Calling again replaces the existing timer.
   */
  startPolling(provider: ProviderId, intervalMs: number, accountProfileId?: string | null): void {
    this.stopPolling(provider, accountProfileId);
    if (intervalMs <= 0) return;
    // Fire one immediate refresh so the chip populates without waiting a tick.
    void this.refresh(provider, accountProfileId);
    const t = setInterval(() => {
      void this.refresh(provider, accountProfileId);
    }, intervalMs);
    // Don't keep the event loop alive purely for quota polling.
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(providerQuotaKey(provider, accountProfileId), t);
  }

  stopPolling(provider: ProviderId, accountProfileId?: string | null): void {
    const key = providerQuotaKey(provider, accountProfileId);
    const t = this.timers.get(key);
    if (t) {
      clearInterval(t);
      this.timers.delete(key);
    }
  }

  /**
   * Start a single low-frequency poll across every registered probe so the
   * usage windows stay fresh even when no loop or adapter activity is driving
   * `quota-auto-refresh`. This is what lets the throttle ladder see ">=90%"
   * *before* a loop starts spilling into paid overage.
   *
   * Ticks are naturally suppressed while paused (the per-provider `refresh()`
   * short-circuits on the pause-coordinator), so we don't special-case it here.
   * `intervalMs <= 0` disables the idle poll. Calling again replaces the timer.
   * Unlike `startPolling`, this does NOT fire an immediate refresh — adapter
   * lifecycle hooks and the renderer's initial `refreshAll()` already cover the
   * cold-start case, and we don't want to stack a probe burst on boot.
   */
  startIdleRefresh(intervalMs: number): void {
    this.stopIdleRefresh();
    if (intervalMs <= 0) return;
    const t = setInterval(() => {
      if (this.isPaused || getPauseCoordinator().isPaused()) return;
      void this.refreshAll();
    }, intervalMs);
    if (typeof t.unref === 'function') t.unref();
    this.idleTimer = t;
  }

  stopIdleRefresh(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Test-only: undo all state and remove listeners. */
  _resetForTesting(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.stopIdleRefresh();
    this.probes.clear();
    this.cliInstalledCheck = null;
    this.alertedKeys.clear();
    this.pacingAlertedKeys.clear();
    this.pacingConfig = { ...DEFAULT_QUOTA_PACING_CONFIG };
    this.lastUsed.clear();
    for (const aborter of this.activeAborters) aborter.abort();
    this.activeAborters.clear();
    for (const p of PROVIDERS) this.snapshots.set(p, null);
    this.accountSnapshots.clear();
    const pauseCoordinator = getPauseCoordinator();
    pauseCoordinator.removeListener('pause', this.handlePause);
    pauseCoordinator.removeListener('resume', this.handleResume);
    this.removeAllListeners();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private storeSnapshot(provider: ProviderId, snapshot: ProviderQuotaSnapshot, accountProfileId?: string | null): void {
    const key = providerQuotaKey(provider, accountProfileId);
    const previous = key === provider
      ? this.snapshots.get(provider) ?? null
      : this.accountSnapshots.get(key) ?? null;
    snapshot = retainLastKnownQuotaWindows(previous, snapshot);
    if (key === provider) {
      this.snapshots.set(provider, snapshot);
    } else {
      snapshot = { ...snapshot, accountProfileId: accountProfileId! };
      this.accountSnapshots.set(key, snapshot);
    }
    this.detectWindowResets(key, snapshot);
    this.emit('quota-updated', snapshot);
    if (snapshot.ok && !this.probes.get(key)?.silenceAlerts) {
      this.checkThresholds(provider, snapshot, key);
      this.checkPacing(provider, snapshot, key);
    }
  }

  private detectWindowResets(
    quotaKey: string,
    snapshot: ProviderQuotaSnapshot,
  ): void {
    for (const w of snapshot.windows) {
      const memoKey = `${quotaKey}:${w.id}`;
      const prev = this.lastUsed.get(memoKey);
      if (prev !== undefined && w.used < prev) {
        // Window reset — clear all alert keys for this (provider/profile, window).
        const prefix = `${quotaKey}:${w.id}:`;
        for (const k of [...this.alertedKeys]) {
          if (k.startsWith(prefix)) this.alertedKeys.delete(k);
        }
        for (const k of [...this.pacingAlertedKeys]) {
          if (k.startsWith(prefix)) this.pacingAlertedKeys.delete(k);
        }
      }
      this.lastUsed.set(memoKey, w.used);
    }
  }

  private checkThresholds(
    provider: ProviderId,
    snapshot: ProviderQuotaSnapshot,
    quotaKey: string = provider,
  ): void {
    for (const w of snapshot.windows) {
      if (w.limit <= 0) continue;
      const pct = (w.used / w.limit) * 100;

      if (pct >= EXHAUSTED_THRESHOLD) {
        const key = `${quotaKey}:${w.id}:${EXHAUSTED_THRESHOLD}`;
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
        const key = `${quotaKey}:${w.id}:${t}`;
        if (this.alertedKeys.has(key)) continue;
        this.alertedKeys.add(key);
        this.emit('quota-warning', this.makeAlert(provider, w, t));
      }
    }
  }

  private checkPacing(provider: ProviderId, snapshot: ProviderQuotaSnapshot, quotaKey: string = provider): void {
    if (!this.pacingConfig.enabled) return;

    for (const window of snapshot.windows) {
      const durationMs = knownWindowDurationMs(window);
      if (durationMs === null || window.limit <= 0 || window.resetsAt === null) continue;

      const remainingMs = window.resetsAt - Date.now();
      if (remainingMs < 0 || remainingMs > durationMs) continue;

      const utilizationPercent = (window.used / window.limit) * 100;
      const elapsedPercent = ((durationMs - remainingMs) / durationMs) * 100;
      if (
        utilizationPercent < this.pacingConfig.utilizationThresholdPercent
        || elapsedPercent > this.pacingConfig.latestElapsedPercent
      ) {
        continue;
      }

      const key = `${quotaKey}:${window.id}:pacing`;
      if (this.pacingAlertedKeys.has(key)) continue;
      this.pacingAlertedKeys.add(key);
      this.emit('quota-pacing-warning', this.makePacingAlert(provider, window, {
        utilizationPercent,
        elapsedPercent,
      }));
    }
  }

  private makeAlert(
    provider: ProviderId,
    window: ProviderQuotaWindow,
    threshold: number,
  ): ProviderQuotaAlert {
    return { provider, window, threshold, timestamp: Date.now() };
  }

  private makePacingAlert(
    provider: ProviderId,
    window: ProviderQuotaWindow,
    metrics: { utilizationPercent: number; elapsedPercent: number },
  ): ProviderQuotaPacingAlert {
    return {
      provider,
      window,
      utilizationPercent: metrics.utilizationPercent,
      elapsedPercent: metrics.elapsedPercent,
      utilizationThresholdPercent: this.pacingConfig.utilizationThresholdPercent,
      latestElapsedPercent: this.pacingConfig.latestElapsedPercent,
      timestamp: Date.now(),
    };
  }
}

/**
 * Only infer durations from stable first-party five-hour/weekly window ids or
 * labels. Calendar and unknown windows are deliberately excluded: without a
 * trustworthy start instant, their elapsed percentage would be fabricated.
 */
export function knownWindowDurationMs(window: ProviderQuotaWindow): number | null {
  const identity = `${window.id} ${window.label}`.toLowerCase();
  if (/(?:^|[.\s_-])5(?:h|[-\s]?hour)(?:$|[.\s_-])/.test(identity)) return FIVE_HOUR_MS;
  if (/(?:^|[.\s_-])weekly?(?:$|[.\s_-])/.test(identity)) return WEEK_MS;
  return null;
}

/**
 * Keep last-known usage bars when a later probe only reports that login has
 * expired. Token-usage-monitor does the same: it skips the poll and leaves
 * the previous windows on screen with an older "updated" time.
 */
export function retainLastKnownQuotaWindows(
  previous: ProviderQuotaSnapshot | null,
  incoming: ProviderQuotaSnapshot,
): ProviderQuotaSnapshot {
  if (incoming.windows.length > 0 || incoming.cliNotInstalled) return incoming;
  if (!incoming.needsReauth) return incoming;
  if (!previous || previous.windows.length === 0 || previous.cliNotInstalled) return incoming;
  return {
    ...previous,
    ok: true,
    needsReauth: true,
    error: incoming.error ?? previous.error,
  };
}

// Lazy singleton — same pattern as cost-tracker.ts.
let providerQuotaInstance: ProviderQuotaService | null = null;

export function getProviderQuotaService(): ProviderQuotaService {
  if (!providerQuotaInstance) {
    providerQuotaInstance = new ProviderQuotaService();
  }
  return providerQuotaInstance;
}
