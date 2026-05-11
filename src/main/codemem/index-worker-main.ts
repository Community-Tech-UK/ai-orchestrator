/**
 * Codemem Index Worker — runs in a worker_thread.
 *
 * Owns CasStore, CodeIndexManager, PeriodicScan, and its own codemem.sqlite
 * connection. No Database object is shared with the main thread. Both
 * connections use WAL mode + busy_timeout so concurrent reads and writes
 * across threads are handled safely.
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
import { CodeIndexManager } from './code-index-manager';
import { workspaceHashForPath } from './symbol-id';
import type {
  IndexWorkerInboundMsg,
  IndexWorkerOutboundMsg,
  WarmWorkspaceResult,
} from './index-worker-protocol';

if (isMainThread) {
  throw new Error('index-worker-main must run in a worker thread');
}

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
  getElectronUserDataPath() ??
  path.join(os.tmpdir(), 'ai-orchestrator');

const dbPath = path.join(userDataPath, 'codemem.sqlite');

// ── SQLite + store ─────────────────────────────────────────────────────────────

const db = defaultDriverFactory(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
migrate(db);

const store = new CasStore(db);
const indexManager = new CodeIndexManager({ store });

// Track which workspaces we've started watchers for.
const watchedWorkspaces = new Set<string>();

// ── IPC ───────────────────────────────────────────────────────────────────────

function respond(id: number, result?: unknown, error?: string): void {
  const msg: IndexWorkerOutboundMsg = { type: 'rpc-response', id, result, error };
  parentPort!.postMessage(msg);
}

// ── Message routing ───────────────────────────────────────────────────────────

parentPort!.on('message', (msg: IndexWorkerInboundMsg) => {
  void handleMessage(msg);
});

async function handleMessage(msg: IndexWorkerInboundMsg): Promise<void> {
  switch (msg.type) {
    case 'warm-workspace': {
      try {
        const normalizedPath = path.resolve(msg.workspacePath);
        const workspaceHash = workspaceHashForPath(normalizedPath);

        // Cold index if the workspace isn't already tracked.
        let workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
        if (!workspaceRoot) {
          await indexManager.coldIndex(normalizedPath);
          workspaceRoot = store.getWorkspaceRootByPath(normalizedPath);
        }

        // Start an incremental watcher if not already watching.
        if (!watchedWorkspaces.has(workspaceHash)) {
          await indexManager.start(normalizedPath, workspaceHash);
          watchedWorkspaces.add(workspaceHash);
        }

        const result: WarmWorkspaceResult = {
          indexed: !!workspaceRoot,
          absPath: workspaceRoot?.absPath ?? normalizedPath,
          primaryLanguage: workspaceRoot?.primaryLanguage ?? 'typescript',
        };
        respond(msg.id, result);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'stop-workspace-watcher': {
      const normalizedPath = path.resolve(msg.workspacePath);
      const workspaceHash = workspaceHashForPath(normalizedPath);
      if (watchedWorkspaces.has(workspaceHash)) {
        watchedWorkspaces.delete(workspaceHash);
        // CodeIndexManager stop is workspace-global — only stop when all are removed.
        if (watchedWorkspaces.size === 0) {
          await indexManager.stop().catch(() => undefined);
        }
      }
      break;
    }

    case 'get-stats': {
      respond(msg.id, { watchedWorkspaces: watchedWorkspaces.size });
      break;
    }

    case 'shutdown': {
      await indexManager.stop().catch(() => undefined);
      db.close();
      respond(msg.id);
      process.exit(0);
      break;
    }
  }
}

// Signal readiness after all synchronous initialisation is complete.
parentPort!.postMessage({ type: 'ready' } satisfies IndexWorkerOutboundMsg);
