/**
 * Codemem Index Worker — runs in an isolated worker process.
 *
 * Owns CasStore, CodeIndexManager, PeriodicScan, and its own codemem.sqlite
 * connection. No Database object is shared with the main thread. Both
 * connections use WAL mode + busy_timeout so concurrent reads and writes are
 * handled safely.
 *
 * Entrypoint resolution follows the LSP worker precedent:
 *   1. Built:  index-worker-main.js from __dirname
 *   2. Dev:    tsx execArgv
 */

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { getElectronParentPort } from '../runtime/electron-parent-port';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { migrate } from './cas-schema';
import { CasStore } from './cas-store';
import {
  checkpointAndTruncateWal,
  CLEANUP_BURST_VACUUM_STEP_PAGES,
  MAINTENANCE_STEP_TIME_BUDGET_MS,
} from './cas-workspace-index-maintenance';
import { isBroadWorkspaceRoot } from './broad-workspace-roots';
import { runCodememMaintenance } from './codemem-pruner';
import { CodeIndexManager } from './code-index-manager';
import { PeriodicScan } from './periodic-scan';
import { getLogger } from '../logging/logger';

const logger = getLogger('CodememIndexWorker');
import { searchHydratedChunks } from './workspace-chunk-search';
import { workspaceHashForPath } from './symbol-id';
import type { WorkspaceHash } from './types';
import type {
  CodeIndexStatusSnapshot,
  CodememMaintenanceSnapshot,
  IndexWorkerInboundMsg,
  IndexWorkerOutboundMsg,
  RebuildIndexMsg,
  RemoveWorkspaceIndexMsg,
  WarmWorkspaceMsg,
  WarmWorkspaceResult,
} from './index-worker-protocol';

interface WorkerTransport {
  postMessage(message: IndexWorkerOutboundMsg): void;
  onMessage(listener: (message: IndexWorkerInboundMsg) => void): void;
}

function createTransport(): WorkerTransport {
  if (parentPort) {
    const port = parentPort;
    return {
      postMessage: (message) => port.postMessage(message),
      onMessage: (listener) => port.on('message', listener),
    };
  }

  // Electron utilityProcess (packaged builds): IPC runs over process.parentPort.
  const electronPort = getElectronParentPort();
  if (electronPort) {
    electronPort.start?.();
    return {
      postMessage: (message) => electronPort.postMessage(message),
      onMessage: (listener) => {
        electronPort.on('message', (event) => listener(event.data as IndexWorkerInboundMsg));
      },
    };
  }

  if (isMainThread && typeof process.send === 'function') {
    process.once('disconnect', () => process.exit(0));
    return {
      postMessage: (message) => process.send?.(message),
      onMessage: (listener) => {
        process.on('message', (message) => listener(message as IndexWorkerInboundMsg));
      },
    };
  }

  throw new Error(
    'index-worker-main must run in a worker thread, utility process, or child process',
  );
}

const transport = createTransport();

// ── Path resolution ────────────────────────────────────────────────────────────

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

const userDataPath =
  (workerData as { userDataPath?: string } | null)?.userDataPath ??
  process.env['AIO_USER_DATA_PATH'] ??
  getElectronUserDataPath() ??
  path.join(os.tmpdir(), 'ai-orchestrator');

const dbPath = path.join(userDataPath, 'codemem.sqlite');

// The vacuum is synchronous, so RPCs wait while it runs. Full maintenance is rare,
// and clean-up bursts return any free space it leaves in much shorter steps.
const MAINTENANCE_VACUUM_TIME_BUDGET_MS = 10_000;
const SPACE_RECLAIM_INTERVAL_MS = 5 * 60 * 1000;
// Clearing up is done in short bursts, so search RPCs get through between them.
const CLEANUP_BURST_PAUSE_MS = 1_250;

// ── SQLite + store ─────────────────────────────────────────────────────────────

const db = defaultDriverFactory(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
migrate(db);

const store = new CasStore(db);
/** Whether deleted rows are still holding space that later bursts must release. */
let spaceReleasePending = false;
try {
  // Short budget: RPCs queue behind startup maintenance. The periodic space
  // reclaim below finishes any remaining shrink in the background.
  runMaintenance(MAINTENANCE_VACUUM_TIME_BUDGET_MS);
} catch (error) {
  logger.warn('Codemem maintenance skipped', { error: error instanceof Error ? error.message : String(error) });
}
const indexManager = new CodeIndexManager({ store });
const periodicScan = new PeriodicScan({ store, mgr: indexManager });
const configuredPeriodicScanIntervalMs = Number(
  process.env['AIO_CODEMEM_PERIODIC_SCAN_INTERVAL_MS'] ?? 15 * 60 * 1000,
);
const PERIODIC_SCAN_INTERVAL_MS = Number.isFinite(configuredPeriodicScanIntervalMs)
  ? configuredPeriodicScanIntervalMs
  : 0;

// Track which workspaces we've started watchers for.
const watchedWorkspaces = new Set<string>();
const watchedWorkspacePaths = new Map<string, string>();
// Workspaces whose index has been reconciled (or freshly built) this worker
// lifetime. Cleared when a workspace's watcher stops, since changes made
// while unwatched must be reconciled on the next warm.
const reconciledWorkspaces = new Set<string>();
let periodicScanTimer: ReturnType<typeof setInterval> | null = null;
let spaceReclaimTimer: ReturnType<typeof setInterval> | null = null;
let cleanupBurstTimer: ReturnType<typeof setTimeout> | null = null;
let periodicScanRunning = false;

indexManager.on('code-index:changed', (event: { workspaceHash: string; paths: string[] }) => {
  const workspacePath = watchedWorkspacePaths.get(event.workspaceHash);
  if (!workspacePath) {
    return;
  }

  transport.postMessage({
    type: 'code-index-changed',
    workspacePath,
    workspaceHash: event.workspaceHash,
    paths: event.paths,
    timestamp: Date.now(),
  } satisfies IndexWorkerOutboundMsg);
});

// ── IPC ───────────────────────────────────────────────────────────────────────

function respond(id: number, result?: unknown, error?: string): void {
  const msg: IndexWorkerOutboundMsg = { type: 'rpc-response', id, result, error };
  transport.postMessage(msg);
}

function exitAfterMessageFlush(): void {
  setImmediate(() => process.exit(0));
}

// ── Message routing ───────────────────────────────────────────────────────────

type HeavyIndexWorkerMsg = WarmWorkspaceMsg | RebuildIndexMsg | RemoveWorkspaceIndexMsg;

let heavyWorkQueue: Promise<void> = Promise.resolve();
let shuttingDown = false;

transport.onMessage((msg: IndexWorkerInboundMsg) => {
  if (isHeavyMessage(msg)) {
    queueHeavyMessage(msg);
    return;
  }
  void handleControlMessage(msg);
});

function isHeavyMessage(msg: IndexWorkerInboundMsg): msg is HeavyIndexWorkerMsg {
  return msg.type === 'warm-workspace' || msg.type === 'rebuild-index' || msg.type === 'remove-workspace-index';
}

function queueHeavyMessage(msg: HeavyIndexWorkerMsg): void {
  const run = heavyWorkQueue.then(async () => {
    if (shuttingDown) {
      respond(msg.id, undefined, 'Index worker is shutting down');
      return;
    }
    await handleHeavyMessage(msg);
  });
  heavyWorkQueue = run.catch(() => undefined);
}

async function handleHeavyMessage(msg: HeavyIndexWorkerMsg): Promise<void> {
  switch (msg.type) {
    case 'remove-workspace-index': {
      try {
        const workspaceHash = workspaceHashForPath(path.resolve(msg.workspacePath));
        await indexManager.stop(workspaceHash);
        watchedWorkspaces.delete(workspaceHash);
        watchedWorkspacePaths.delete(workspaceHash);
        reconciledWorkspaces.delete(workspaceHash);
        if (watchedWorkspaces.size === 0) stopPeriodicDriftScan();
        store.deleteWorkspaceIndex(workspaceHash);
        spaceReleasePending = true;
        scheduleCleanupBurst();
        respond(msg.id, true);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }
    case 'warm-workspace': {
      try {
        await warmWorkspace(msg);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'rebuild-index': {
      try {
        await rebuildIndex(msg);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }
  }
}

async function handleControlMessage(msg: Exclude<IndexWorkerInboundMsg, HeavyIndexWorkerMsg>): Promise<void> {
  switch (msg.type) {
    case 'get-index-status': {
      const normalizedPath = path.resolve(msg.workspacePath);
      const workspaceHash = workspaceHashForPath(normalizedPath);
      respond(msg.id, buildStatusSnapshot(normalizedPath, workspaceHash));
      break;
    }

    case 'cancel-index': {
      const normalizedPath = path.resolve(msg.workspacePath);
      const workspaceHash = workspaceHashForPath(normalizedPath);
      store.requestCancel(workspaceHash);
      respond(msg.id);
      break;
    }

    case 'stop-workspace-watcher': {
      const normalizedPath = path.resolve(msg.workspacePath);
      const workspaceHash = workspaceHashForPath(normalizedPath);
      if (watchedWorkspaces.has(workspaceHash)) {
        watchedWorkspaces.delete(workspaceHash);
        watchedWorkspacePaths.delete(workspaceHash);
        // Changes made while unwatched must be reconciled on the next warm.
        reconciledWorkspaces.delete(workspaceHash);
        // CodeIndexManager stop is workspace-global — only stop when all are removed.
        if (watchedWorkspaces.size === 0) {
          stopPeriodicDriftScan();
          await indexManager.stop().catch(() => undefined);
        }
      }
      break;
    }

    case 'search-workspace-chunks': {
      try {
        const normalizedPath = path.resolve(msg.workspacePath);
        respond(msg.id, searchHydratedChunks(store, normalizedPath, msg.query, msg.limit, {
          strongMatchOnly: msg.strongMatchOnly,
        }));
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'get-stats': {
      respond(msg.id, { watchedWorkspaces: watchedWorkspaces.size });
      break;
    }

    case 'run-maintenance': {
      try {
        // Same short budget as startup: other RPCs queue behind this call.
        respond(msg.id, runMaintenance(MAINTENANCE_VACUUM_TIME_BUDGET_MS));
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'shutdown': {
      shuttingDown = true;
      stopPeriodicDriftScan();
      stopSpaceReclaim();
      await indexManager.stop().catch(() => undefined);
      db.close();
      respond(msg.id);
      exitAfterMessageFlush();
      break;
    }
  }
}

async function warmWorkspace(msg: WarmWorkspaceMsg): Promise<void> {
  const normalizedPath = path.resolve(msg.workspacePath);
  if (isBroadWorkspaceRoot(normalizedPath)) {
    logger.info('Codemem warm-up skipped broad filesystem root', { workspacePath: normalizedPath });
    respond(msg.id, degradedWarmWorkspaceResult(normalizedPath));
    return;
  }
  const workspaceHash = workspaceHashForPath(normalizedPath);

  let workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
  const hadExistingIndex = Boolean(workspaceRoot);
  if (!workspaceRoot) {
    await indexManager.coldIndex(normalizedPath);
    workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
  }

  if (!workspaceRoot) {
    respond(msg.id, degradedWarmWorkspaceResult(normalizedPath));
    return;
  }

  await startWatcherIfNeeded(normalizedPath, workspaceHash);

  // Respond before reconciling: warm callers sit on short spawn timeouts and
  // only need the index to exist. The reconcile below still runs inside the
  // serialized heavy queue, so it cannot overlap a cold index or rebuild.
  respond(msg.id, {
    indexed: true,
    absPath: workspaceRoot.absPath,
    primaryLanguage: workspaceRoot.primaryLanguage ?? 'typescript',
  } satisfies WarmWorkspaceResult);

  const needsReconcile = hadExistingIndex && !reconciledWorkspaces.has(workspaceHash);
  reconciledWorkspaces.add(workspaceHash);
  if (!needsReconcile) {
    return;
  }

  try {
    // An existing index may predate this worker: no watcher was running while
    // the app was closed, so diff the manifest against the filesystem once.
    store.clearCancel(workspaceHash);
    await indexManager.reconcileIndex(normalizedPath);
  } catch (error) {
    logger.warn('Codemem warm reconcile failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function rebuildIndex(msg: RebuildIndexMsg): Promise<void> {
  const normalizedPath = path.resolve(msg.workspacePath);
  if (isBroadWorkspaceRoot(normalizedPath)) {
    logger.info('Codemem rebuild skipped broad filesystem root', { workspacePath: normalizedPath });
    respond(msg.id, degradedWarmWorkspaceResult(normalizedPath));
    return;
  }
  const workspaceHash = workspaceHashForPath(normalizedPath);
  store.clearCancel(workspaceHash);
  await indexManager.coldIndex(normalizedPath);
  // A fresh cold index leaves nothing to reconcile on the next warm.
  reconciledWorkspaces.add(workspaceHash);
  const workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);

  if (!workspaceRoot) {
    respond(msg.id, degradedWarmWorkspaceResult(normalizedPath));
    return;
  }

  await startWatcherIfNeeded(normalizedPath, workspaceHash);

  respond(msg.id, {
    indexed: true,
    absPath: workspaceRoot.absPath,
    primaryLanguage: workspaceRoot.primaryLanguage ?? 'typescript',
  } satisfies WarmWorkspaceResult);
}

async function startWatcherIfNeeded(normalizedPath: string, workspaceHash: string): Promise<void> {
  if (!watchedWorkspaces.has(workspaceHash)) {
    await indexManager.start(normalizedPath, workspaceHash);
    watchedWorkspaces.add(workspaceHash);
    startPeriodicDriftScan();
  }
  watchedWorkspacePaths.set(workspaceHash, normalizedPath);
}

function startPeriodicDriftScan(): void {
  if (periodicScanTimer || PERIODIC_SCAN_INTERVAL_MS <= 0) {
    return;
  }
  periodicScanTimer = setInterval(() => {
    // Serialize repairs with index deletion so an in-flight scan cannot
    // recreate rows belonging to a retired worktree.
    heavyWorkQueue = heavyWorkQueue.then(runPeriodicDriftScan).catch(error => {
      logger.warn('Codemem periodic drift scan failed', { error: String(error) });
    });
  }, PERIODIC_SCAN_INTERVAL_MS);
  periodicScanTimer.unref?.();
}

function stopPeriodicDriftScan(): void {
  if (!periodicScanTimer) {
    return;
  }
  clearInterval(periodicScanTimer);
  periodicScanTimer = null;
}

async function runPeriodicDriftScan(): Promise<void> {
  if (periodicScanRunning || shuttingDown) {
    return;
  }
  periodicScanRunning = true;
  try {
    // Snapshot: the set can change across the awaited scans.
    for (const workspaceHash of Array.from(watchedWorkspaces)) {
      if (shuttingDown) {
        return;
      }
      await periodicScan.runOnce(workspaceHash as WorkspaceHash);
    }
  } catch (error) {
    logger.warn('Codemem periodic drift scan failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    periodicScanRunning = false;
  }
}

function degradedWarmWorkspaceResult(normalizedPath: string): WarmWorkspaceResult {
  return {
    indexed: false,
    absPath: normalizedPath,
    primaryLanguage: 'typescript',
  };
}

function startSpaceReclaim(): void {
  if (spaceReclaimTimer) {
    return;
  }
  spaceReclaimTimer = setInterval(scheduleCleanupBurst, SPACE_RECLAIM_INTERVAL_MS);
  spaceReclaimTimer.unref?.();
  scheduleCleanupBurst();
}

function stopSpaceReclaim(): void {
  if (cleanupBurstTimer) {
    clearTimeout(cleanupBurstTimer);
    cleanupBurstTimer = null;
  }
  if (!spaceReclaimTimer) {
    return;
  }
  clearInterval(spaceReclaimTimer);
  spaceReclaimTimer = null;
}

function scheduleCleanupBurst(): void {
  if (cleanupBurstTimer || shuttingDown) {
    return;
  }
  cleanupBurstTimer = setTimeout(runCleanupBurst, CLEANUP_BURST_PAUSE_MS);
  cleanupBurstTimer.unref?.();
}

function runCleanupBurst(): void {
  cleanupBurstTimer = null;
  if (shuttingDown) {
    return;
  }
  try {
    if (runCleanupStep()) {
      scheduleCleanupBurst();
    }
  } catch (error) {
    logger.warn('Codemem cleanup burst failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * One bounded step, returning whether more remains. Abandoned workspaces go
 * first, then the space they held is released to free pages inside the file, and
 * finally those pages go back to the filesystem.
 */
function runCleanupStep(): boolean {
  const abandoned = store.pruneAbandonedWorkspaces();
  spaceReleasePending ||= abandoned.deletedChunks > 0 || abandoned.deletedWorkspaces > 0;
  if (abandoned.remainingWorkspaces > 0) {
    return true;
  }

  if (spaceReleasePending) {
    spaceReleasePending = !store.releaseDeletedSpace().finished;
    if (!spaceReleasePending) {
      logger.info('Codemem finished releasing deleted space');
    }
    return true;
  }

  const reclaim = store.vacuumFreelistPages({
    timeBudgetMs: MAINTENANCE_STEP_TIME_BUDGET_MS,
    stepPages: CLEANUP_BURST_VACUUM_STEP_PAGES,
    allowFullVacuum: false,
  });
  if (reclaim.stoppedReason === 'time-budget') {
    return true;
  }
  if (reclaim.freedPages > 0 || reclaim.stoppedReason === 'checkpoint-busy') {
    logger.info('Codemem space reclaim ran', { ...reclaim });
  }
  return false;
}

function runMaintenance(vacuumTimeBudgetMs?: number): CodememMaintenanceSnapshot {
  const result = runCodememMaintenance(store, {
    maxWorkspaces: Number(process.env['AIO_CODEMEM_MAX_WORKSPACES'] ?? 10),
    maxManifestEntriesPerWorkspace: Number(process.env['AIO_CODEMEM_MAX_MANIFEST_ENTRIES'] ?? 500_000),
    workspaceExists: existsSync,
    vacuumTimeBudgetMs,
  });
  spaceReleasePending ||= !result.spaceReleaseFinished;
  const walTruncated = checkpointAndTruncateWal(db);
  if (!walTruncated || result.vacuum.stoppedReason === 'checkpoint-busy') {
    logger.warn('Codemem maintenance could not finish shrinking the database; an open read held the WAL', {
      remainingFreePages: result.vacuum.remainingFreePages,
      walTruncated,
    });
  }
  return { ...result, walTruncated };
}

startSpaceReclaim();

// Signal readiness after all synchronous initialisation is complete.
transport.postMessage({ type: 'ready' } satisfies IndexWorkerOutboundMsg);

function buildStatusSnapshot(
  workspacePath: string,
  workspaceHash: string,
): CodeIndexStatusSnapshot | null {
  const status = store.getIndexStatus(workspaceHash);
  if (!status) {
    return null;
  }
  return {
    workspacePath,
    workspaceHash,
    state: status.state,
    phase: status.phase,
    totalFiles: status.totalFiles,
    processedFiles: status.processedFiles,
    totalChunks: status.totalChunks,
    processedChunks: status.processedChunks,
    currentPath: status.currentPath,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    completedAt: status.completedAt,
    etaMs: estimateEtaMs(status.startedAt, status.updatedAt, status.processedFiles, status.totalFiles),
    errorMessage: status.errorMessage,
  };
}

function estimateEtaMs(
  startedAt: number | null,
  updatedAt: number,
  processed: number,
  total: number,
): number | null {
  if (!startedAt || processed <= 0 || total <= processed) {
    return null;
  }
  const elapsed = Math.max(0, updatedAt - startedAt);
  const perFile = elapsed / processed;
  return Math.max(0, Math.round(perFile * (total - processed)));
}
