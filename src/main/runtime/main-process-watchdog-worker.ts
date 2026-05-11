/**
 * Watchdog worker — runs in a worker_thread.
 *
 * Receives periodic heartbeat messages from the main process. If the gap
 * between heartbeats exceeds STALL_THRESHOLD_MS, writes a small JSON report
 * to userData/diagnostics/watchdog-report.json so the next app start can log
 * a warning about the prior-run stall.
 */

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WatchdogInboundMsg,
  WatchdogReport,
  WatchdogHeartbeatMetrics,
} from './main-process-watchdog-protocol';

if (isMainThread) {
  throw new Error('main-process-watchdog-worker must run in a worker thread');
}

// ── Config ────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 2_000;
const STALL_THRESHOLD_MS = 5_000;

const userDataPath: string =
  (workerData as { userDataPath?: string } | null)?.userDataPath ?? '/tmp/ai-orchestrator';
const appVersion: string =
  (workerData as { appVersion?: string } | null)?.appVersion ?? 'unknown';
const reportPath = path.join(userDataPath, 'diagnostics', 'watchdog-report.json');

// ── State ─────────────────────────────────────────────────────────────────────

let lastHeartbeatAt = Date.now();
let lastMetrics: WatchdogHeartbeatMetrics | null = null;
let stallWritten = false;
let checkTimer: ReturnType<typeof setInterval> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeReport(): void {
  const now = Date.now();
  const report: WatchdogReport = {
    stallDetectedAt: now,
    lastHeartbeatAt,
    stalledForMs: now - lastHeartbeatAt,
    lastMetrics,
    appVersion,
  };
  try {
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    // Best-effort: if we can't write the report, don't crash the worker.
  }
}

function startCheckTimer(): void {
  checkTimer = setInterval(() => {
    const age = Date.now() - lastHeartbeatAt;
    if (age > STALL_THRESHOLD_MS && !stallWritten) {
      writeReport();
      stallWritten = true;
    }
  }, CHECK_INTERVAL_MS);
  checkTimer.unref();
}

// ── Message routing ───────────────────────────────────────────────────────────

parentPort!.on('message', (msg: WatchdogInboundMsg) => {
  switch (msg.type) {
    case 'heartbeat': {
      lastHeartbeatAt = msg.timestamp;
      lastMetrics = msg.metrics;
      stallWritten = false;
      break;
    }
    case 'shutdown': {
      if (checkTimer !== null) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
      process.exit(0);
      break;
    }
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

startCheckTimer();
parentPort!.postMessage({ type: 'ready' });
