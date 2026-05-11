/**
 * MainProcessWatchdog — main-process side of the watchdog subsystem.
 *
 * Sends a heartbeat message to the watchdog worker every HEARTBEAT_INTERVAL_MS.
 * The worker writes a stall report to disk if heartbeats stop arriving, so the
 * next app start can log a warning.
 *
 * Call `checkPriorWatchdogReport()` once at startup (before starting the
 * watchdog) to log any stall detected in the previous run.
 */

import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { WatchdogInboundMsg, WatchdogReport, WatchdogHeartbeatMetrics } from './main-process-watchdog-protocol';

// ── Constants ─────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WatchdogMetricsProvider {
  getEventLoopLagP95Ms(): number;
  getEventLoopLagMaxMs(): number;
  getProviderBusEmitted(): number;
  getProviderBusDroppedStatus(): number;
  getContextWorkerInFlight(): number;
  getContextWorkerDegraded(): boolean;
  getIndexWorkerInFlight(): number;
  getIndexWorkerDegraded(): boolean;
  getActiveInstanceCount(): number;
}

// ── Worker factory ────────────────────────────────────────────────────────────

function makeWatchdogWorker(userDataPath: string, appVersion: string): Worker {
  const jsEntry = path.join(__dirname, 'main-process-watchdog-worker.js');
  if (existsSync(jsEntry)) {
    return new Worker(jsEntry, { workerData: { userDataPath, appVersion } });
  }
  const tsEntry = path.join(__dirname, 'main-process-watchdog-worker.ts');
  return new Worker(tsEntry, {
    workerData: { userDataPath, appVersion },
    execArgv: ['--import', 'tsx'],
  });
}

// ── MainProcessWatchdog ───────────────────────────────────────────────────────

export class MainProcessWatchdog {
  private worker: Worker | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly userDataPath: string;
  private readonly appVersion: string;
  private readonly metricsProvider: WatchdogMetricsProvider;
  private readonly workerFactory: (userDataPath: string, appVersion: string) => Worker;

  constructor(options: {
    userDataPath: string;
    appVersion: string;
    metricsProvider: WatchdogMetricsProvider;
    workerFactory?: (userDataPath: string, appVersion: string) => Worker;
  }) {
    this.userDataPath = options.userDataPath;
    this.appVersion = options.appVersion;
    this.metricsProvider = options.metricsProvider;
    this.workerFactory = options.workerFactory ?? makeWatchdogWorker;
  }

  start(): void {
    if (this.worker) return;

    try {
      this.worker = this.workerFactory(this.userDataPath, this.appVersion);
      this.worker.on('error', () => {
        // Watchdog failure is non-critical — silence and don't restart.
        this.worker = null;
        this.stopHeartbeat();
      });
      this.worker.on('exit', () => {
        this.worker = null;
        this.stopHeartbeat();
      });
    } catch {
      return;
    }

    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.worker) {
      const msg: WatchdogInboundMsg = { type: 'shutdown' };
      try {
        this.worker.postMessage(msg);
      } catch {
        // best-effort
      }
      await this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.worker) return;
    const p = this.metricsProvider;
    const metrics: WatchdogHeartbeatMetrics = {
      eventLoopLagP95Ms: p.getEventLoopLagP95Ms(),
      eventLoopLagMaxMs: p.getEventLoopLagMaxMs(),
      providerBusEmitted: p.getProviderBusEmitted(),
      providerBusDroppedStatus: p.getProviderBusDroppedStatus(),
      contextWorkerInFlight: p.getContextWorkerInFlight(),
      contextWorkerDegraded: p.getContextWorkerDegraded(),
      indexWorkerInFlight: p.getIndexWorkerInFlight(),
      indexWorkerDegraded: p.getIndexWorkerDegraded(),
      activeInstanceCount: p.getActiveInstanceCount(),
    };
    const msg: WatchdogInboundMsg = { type: 'heartbeat', timestamp: Date.now(), metrics };
    try {
      this.worker.postMessage(msg);
    } catch {
      // ignore — worker may be shutting down
    }
  }
}

// ── Startup check ─────────────────────────────────────────────────────────────

/**
 * Reads any stall report written by the watchdog worker in the previous run.
 * Returns the report if one exists, or null. Removes the file after reading.
 */
export function readPriorWatchdogReport(userDataPath: string): WatchdogReport | null {
  const reportPath = path.join(userDataPath, 'diagnostics', 'watchdog-report.json');
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    fs.unlinkSync(reportPath);
    return JSON.parse(raw) as WatchdogReport;
  } catch {
    return null;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let watchdog: MainProcessWatchdog | null = null;

export function getMainProcessWatchdog(): MainProcessWatchdog {
  if (!watchdog) {
    throw new Error('MainProcessWatchdog has not been initialized — call initializeMainProcessWatchdog first');
  }
  return watchdog;
}

export function initializeMainProcessWatchdog(options: {
  userDataPath: string;
  appVersion: string;
  metricsProvider: WatchdogMetricsProvider;
  workerFactory?: (userDataPath: string, appVersion: string) => Worker;
}): MainProcessWatchdog {
  if (watchdog) return watchdog;
  watchdog = new MainProcessWatchdog(options);
  return watchdog;
}

export function _resetMainProcessWatchdogForTesting(): void {
  if (watchdog) {
    void watchdog.stop();
    watchdog = null;
  }
}
