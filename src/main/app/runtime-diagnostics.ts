import { app, BrowserWindow, powerMonitor } from 'electron';
import { getObservationIngestor } from '../observation';
import { getSessionContinuityManagerIfInitialized } from '../session/session-continuity';
import { getHibernationManager } from '../process/hibernation-manager';
import { getPoolManager } from '../process/pool-manager';
import { getLogger } from '../logging/logger';
import { readPriorWatchdogReport } from '../runtime/main-process-watchdog';

const logger = getLogger('RuntimeDiagnostics');
const MAIN_PROCESS_MONITOR_INTERVAL_MS = 1000;
const MAIN_PROCESS_STALL_THRESHOLD_MS = 2000;
const POST_RESUME_GRACE_PERIOD_MS = 60_000;

let runtimeDiagnosticsInstalled = false;

function roundMegabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function installRuntimeDiagnostics(): void {
  if (runtimeDiagnosticsInstalled) {
    return;
  }

  runtimeDiagnosticsInstalled = true;

  const priorReport = readPriorWatchdogReport(app.getPath('userData'));
  if (priorReport) {
    logger.warn('Prior run had a main-thread stall detected by watchdog', {
      stallDetectedAt: new Date(priorReport.stallDetectedAt).toISOString(),
      stalledForMs: priorReport.stalledForMs,
      appVersion: priorReport.appVersion,
      lastMetrics: priorReport.lastMetrics,
    });
  }

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }

    const detailRecord = details as unknown as Record<string, unknown>;
    logger.error('Electron child process exited unexpectedly', undefined, {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: detailRecord['name'],
      serviceName: detailRecord['serviceName'],
    });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning emitted', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });

  let lastTick = Date.now();
  const noteSystemSuspend = (source: 'suspend' | 'lock-screen'): void => {
    logger.info('System power event observed', { source });
    getObservationIngestor().handleSystemSuspend();
    getSessionContinuityManagerIfInitialized()?.handleSystemSuspend();
    getHibernationManager().handleSystemSuspend();
    getPoolManager().handleSystemSuspend();
  };
  const noteSystemResume = (source: 'resume' | 'unlock-screen'): void => {
    lastTick = Date.now();
    logger.info('System resumed; deferring background timers', {
      source,
      graceMs: POST_RESUME_GRACE_PERIOD_MS,
    });
    getObservationIngestor().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getSessionContinuityManagerIfInitialized()?.handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getHibernationManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getPoolManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
  };

  powerMonitor.on('suspend', () => {
    noteSystemSuspend('suspend');
  });
  powerMonitor.on('resume', () => {
    noteSystemResume('resume');
  });
  powerMonitor.on('lock-screen', () => {
    noteSystemSuspend('lock-screen');
  });
  powerMonitor.on('unlock-screen', () => {
    noteSystemResume('unlock-screen');
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const stallMs = now - lastTick - MAIN_PROCESS_MONITOR_INTERVAL_MS;
    lastTick = now;

    if (stallMs < MAIN_PROCESS_STALL_THRESHOLD_MS) {
      return;
    }

    const memory = process.memoryUsage();
    logger.warn('Main process event loop stall detected', {
      stallMs,
      windowCount: BrowserWindow.getAllWindows().length,
      rssMB: roundMegabytes(memory.rss),
      heapUsedMB: roundMegabytes(memory.heapUsed),
      heapTotalMB: roundMegabytes(memory.heapTotal),
      externalMB: roundMegabytes(memory.external),
      arrayBuffersMB: roundMegabytes(memory.arrayBuffers),
    });
  }, MAIN_PROCESS_MONITOR_INTERVAL_MS);
  timer.unref();
}
