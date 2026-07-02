/**
 * System Load Monitor
 *
 * Tracks host CPU pressure (1-minute loadavg per core) and recent main-process
 * event-loop stalls, and exposes a watchdog timeout multiplier so process
 * watchdogs can distinguish "the child is hung" from "the whole machine is
 * starved".
 *
 * Motivation (2026-07-01 incident): the host hit a 15-minute load average of
 * ~290 while three full-implementation Codex sessions ran their test gates
 * concurrently. Starved-but-healthy CLI processes stopped producing output,
 * so the stream-idle watchdog, StuckProcessDetector, and the fixed 60s
 * `thread/start` RPC timeout all fired on calm-weather thresholds and killed
 * or failed sessions that only needed more time. This monitor lets those
 * watchdogs stretch their thresholds while the host is overloaded.
 *
 * Electron-free (node:os only) so it is safe to import from CLI adapters that
 * also run inside spawn-worker processes.
 */

import os from 'node:os';
import { getLogger } from '../logging/logger';

const logger = getLogger('SystemLoadMonitor');

export interface SystemLoadSnapshot {
  /** 1-minute load average (0 on Windows, where loadavg is unsupported). */
  load1: number;
  /** Logical CPU count used for normalization. */
  cpuCount: number;
  /** load1 / cpuCount — >1 means more runnable work than cores. */
  loadPerCore: number;
  /** Whether an event-loop stall was reported within the recency window. */
  recentEventLoopStall: boolean;
  /** Current watchdog timeout multiplier (1 = calm). */
  multiplier: number;
  /** True when the multiplier is above 1. */
  overloaded: boolean;
}

export interface SystemLoadMonitorOptions {
  /** Injectable loadavg reader for tests. Defaults to os.loadavg. */
  readLoadAvg?: () => number[];
  /** Injectable CPU count for tests. Defaults to os.cpus().length. */
  cpuCount?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** How long a loadavg sample is cached before re-reading. */
  sampleTtlMs?: number;
}

/** loadavg is cheap but there's no reason to re-read it on every timer tick. */
const DEFAULT_SAMPLE_TTL_MS = 5_000;

/**
 * How long a reported event-loop stall keeps the multiplier elevated.
 * Stalls are point events; treat the host as suspect for a minute after each.
 */
const STALL_RECENCY_WINDOW_MS = 60_000;

/** Ignore sub-second stall reports — they are routine GC/paint hiccups. */
const STALL_MIN_MS = 1_000;

/** A recent event-loop stall guarantees at least this multiplier. */
const STALL_FLOOR_MULTIPLIER = 2;

/**
 * Load-per-core → multiplier ladder (checked top-down, first match wins).
 * 1.5x cores runnable is already saturated; 6x is the 2026-07-01 regime.
 */
const LOAD_TIERS: ReadonlyArray<{ loadPerCore: number; multiplier: number }> = [
  { loadPerCore: 6, multiplier: 4 },
  { loadPerCore: 3, multiplier: 3 },
  { loadPerCore: 1.5, multiplier: 2 },
];

export class SystemLoadMonitor {
  private readonly readLoadAvg: () => number[];
  private readonly cpuCount: number;
  private readonly now: () => number;
  private readonly sampleTtlMs: number;

  private cachedLoad1 = 0;
  private lastSampleAt = -Infinity;
  private lastStallAt = -Infinity;
  private lastLoggedMultiplier = 1;

  constructor(options: SystemLoadMonitorOptions = {}) {
    this.readLoadAvg = options.readLoadAvg ?? (() => os.loadavg());
    this.cpuCount = Math.max(1, options.cpuCount ?? os.cpus().length);
    this.now = options.now ?? Date.now;
    this.sampleTtlMs = options.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS;
  }

  /**
   * Report a main-process event-loop stall (from RuntimeDiagnostics).
   * Keeps the multiplier at or above STALL_FLOOR_MULTIPLIER for the
   * recency window even when loadavg looks calm (e.g. Windows, or when
   * the pressure is IO/swap rather than runnable threads).
   */
  reportEventLoopStall(stallMs: number): void {
    if (!Number.isFinite(stallMs) || stallMs < STALL_MIN_MS) return;
    this.lastStallAt = this.now();
  }

  /**
   * Watchdog timeout multiplier: 1 when the host is calm, up to 4 when it is
   * heavily oversubscribed. Callers multiply their idle/stuck thresholds by
   * this so starved-but-healthy children are not declared dead.
   */
  getWatchdogMultiplier(): number {
    return this.getSnapshot().multiplier;
  }

  /** True when the watchdog multiplier is above 1. */
  isOverloaded(): boolean {
    return this.getSnapshot().overloaded;
  }

  getSnapshot(): SystemLoadSnapshot {
    const now = this.now();
    if (now - this.lastSampleAt >= this.sampleTtlMs) {
      this.cachedLoad1 = this.safeLoad1();
      this.lastSampleAt = now;
    }

    const loadPerCore = this.cachedLoad1 / this.cpuCount;
    const recentEventLoopStall = now - this.lastStallAt < STALL_RECENCY_WINDOW_MS;

    let multiplier = 1;
    for (const tier of LOAD_TIERS) {
      if (loadPerCore >= tier.loadPerCore) {
        multiplier = tier.multiplier;
        break;
      }
    }
    if (recentEventLoopStall && multiplier < STALL_FLOOR_MULTIPLIER) {
      multiplier = STALL_FLOOR_MULTIPLIER;
    }

    if (multiplier !== this.lastLoggedMultiplier) {
      logger.info('Watchdog load multiplier changed', {
        from: this.lastLoggedMultiplier,
        to: multiplier,
        load1: Math.round(this.cachedLoad1 * 100) / 100,
        cpuCount: this.cpuCount,
        loadPerCore: Math.round(loadPerCore * 100) / 100,
        recentEventLoopStall,
      });
      this.lastLoggedMultiplier = multiplier;
    }

    return {
      load1: this.cachedLoad1,
      cpuCount: this.cpuCount,
      loadPerCore,
      recentEventLoopStall,
      multiplier,
      overloaded: multiplier > 1,
    };
  }

  private safeLoad1(): number {
    try {
      const load1 = this.readLoadAvg()[0];
      return Number.isFinite(load1) && load1 > 0 ? load1 : 0;
    } catch {
      return 0;
    }
  }
}

let sharedInstance: SystemLoadMonitor | null = null;

export function getSystemLoadMonitor(): SystemLoadMonitor {
  if (!sharedInstance) {
    sharedInstance = new SystemLoadMonitor();
  }
  return sharedInstance;
}

export function _resetSystemLoadMonitorForTesting(): void {
  sharedInstance = null;
}

/**
 * Multiplier accessor for watchdog call sites (stream-idle, stuck detection,
 * codex RPC control timeouts).
 *
 * Returns 1 under vitest so timing-sensitive specs stay deterministic
 * regardless of how loaded the machine running the tests is — specs that
 * exercise load scaling inject their own multiplier or construct
 * SystemLoadMonitor directly.
 */
export function getLoadWatchdogMultiplier(): number {
  if (process.env['VITEST'] === 'true') return 1;
  return getSystemLoadMonitor().getWatchdogMultiplier();
}

/**
 * Clamped, throw-safe variant of {@link getLoadWatchdogMultiplier} for direct
 * use at timeout call sites: always finite, >= 1, and capped so a diagnostics
 * glitch can never disable a watchdog entirely.
 */
export function getClampedLoadWatchdogMultiplier(maxMultiplier = 8): number {
  try {
    const multiplier = getLoadWatchdogMultiplier();
    if (!Number.isFinite(multiplier) || multiplier < 1) return 1;
    return Math.min(multiplier, maxMultiplier);
  } catch {
    return 1;
  }
}
