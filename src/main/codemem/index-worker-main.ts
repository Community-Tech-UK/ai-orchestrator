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
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { migrate } from './cas-schema';
import { CasStore } from './cas-store';
import { pruneCodememWorkspaces } from './codemem-pruner';
import { CodeIndexManager } from './code-index-manager';
import { searchHydratedChunks } from './workspace-chunk-search';
import { workspaceHashForPath } from './symbol-id';
import type {
  CodeIndexStatusSnapshot,
  IndexWorkerInboundMsg,
  IndexWorkerOutboundMsg,
  RebuildIndexMsg,
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

  if (isMainThread && typeof process.send === 'function') {
    process.once('disconnect', () => process.exit(0));
    return {
      postMessage: (message) => process.send?.(message),
      onMessage: (listener) => {
        process.on('message', (message) => listener(message as IndexWorkerInboundMsg));
      },
    };
  }

  throw new Error('index-worker-main must run in a worker thread or child process');
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

// ── SQLite + store ─────────────────────────────────────────────────────────────

const db = defaultDriverFactory(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
migrate(db);

const store = new CasStore(db);
try {
  if (
    typeof store.listWorkspaceIndexStats === 'function' &&
    typeof store.deleteWorkspaceIndex === 'function'
  ) {
    pruneCodememWorkspaces(store, {
      maxWorkspaces: Number(process.env['AIO_CODEMEM_MAX_WORKSPACES'] ?? 10),
      maxManifestEntriesPerWorkspace: Number(process.env['AIO_CODEMEM_MAX_MANIFEST_ENTRIES'] ?? 500_000),
    });
    db.pragma('wal_checkpoint(TRUNCATE)');
  }
} catch (error) {
  console.warn('Codemem pruning skipped', error instanceof Error ? error.message : String(error));
}
const indexManager = new CodeIndexManager({ store });

// Track which workspaces we've started watchers for.
const watchedWorkspaces = new Set<string>();
const watchedWorkspacePaths = new Map<string, string>();

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

type HeavyIndexWorkerMsg = WarmWorkspaceMsg | RebuildIndexMsg;

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
  return msg.type === 'warm-workspace' || msg.type === 'rebuild-index';
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
        // CodeIndexManager stop is workspace-global — only stop when all are removed.
        if (watchedWorkspaces.size === 0) {
          await indexManager.stop().catch(() => undefined);
        }
      }
      break;
    }

    case 'search-workspace-chunks': {
      try {
        const normalizedPath = path.resolve(msg.workspacePath);
        respond(msg.id, searchHydratedChunks(store, normalizedPath, msg.query, msg.limit));
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'get-stats': {
      respond(msg.id, { watchedWorkspaces: watchedWorkspaces.size });
      break;
    }

    case 'shutdown': {
      shuttingDown = true;
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
  const workspaceHash = workspaceHashForPath(normalizedPath);

  let workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
  if (!workspaceRoot) {
    await indexManager.coldIndex(normalizedPath);
    workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
  }

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

async function rebuildIndex(msg: RebuildIndexMsg): Promise<void> {
  const normalizedPath = path.resolve(msg.workspacePath);
  const workspaceHash = workspaceHashForPath(normalizedPath);
  store.clearCancel(workspaceHash);
  await indexManager.coldIndex(normalizedPath);
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
  }
  watchedWorkspacePaths.set(workspaceHash, normalizedPath);
}

function degradedWarmWorkspaceResult(normalizedPath: string): WarmWorkspaceResult {
  return {
    indexed: false,
    absPath: normalizedPath,
    primaryLanguage: 'typescript',
  };
}

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
