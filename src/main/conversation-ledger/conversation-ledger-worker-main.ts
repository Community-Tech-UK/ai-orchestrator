/**
 * Conversation Ledger Worker — runs in a worker_thread.
 *
 * Solely owns the on-disk conversation-ledger.db connection and its
 * ConversationLedgerStore, so that the ledger's synchronous better-sqlite3
 * reads and writes never run on the Electron main event loop. Being the sole
 * writer also avoids two-writer contention: the main process never opens this
 * database in production.
 *
 * IMPORTANT (worker import isolation): this file and everything in its value
 * import closure must NOT top-level `import … from 'electron'` — that module is
 * unresolvable in a worker_thread and crashes it at load. We therefore
 * deep-import the store/schema/driver directly (never the conversation-ledger
 * barrel, which re-exports the electron-importing service) and resolve the
 * userData path through a lazy guarded require. The sibling
 * `conversation-ledger-worker-import-isolation.spec.ts` enforces this statically.
 *
 * Entrypoint resolution follows the index/context worker precedent:
 *   1. Built:  conversation-ledger-worker-main.js from __dirname
 *   2. Dev:    tsx execArgv
 */

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { runConversationLedgerMigrations } from './conversation-ledger-schema';
import { ConversationLedgerStore } from './conversation-ledger-store';
import type { AppendMessageInput, LedgerStoreMethod } from './ledger-store-port';
import type {
  ConversationListQuery,
  ConversationMessageUpsertInput,
  ConversationMessagesQuery,
  ConversationSyncCursorUpsertInput,
  ConversationThreadUpsertInput,
} from '../../shared/types/conversation-ledger.types';
import type {
  LedgerWorkerInboundMsg,
  LedgerWorkerOutboundMsg,
} from './conversation-ledger-worker-protocol';

if (isMainThread) {
  throw new Error('conversation-ledger-worker-main must run in a worker thread');
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

const dbPath = path.join(userDataPath, 'conversation-ledger', 'conversation-ledger.db');
mkdirSync(path.dirname(dbPath), { recursive: true });

// ── SQLite + store ─────────────────────────────────────────────────────────────

const db = defaultDriverFactory(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
runConversationLedgerMigrations(db);

const store = new ConversationLedgerStore(db);

// ── IPC ───────────────────────────────────────────────────────────────────────

function respond(id: number, result?: unknown, error?: string): void {
  const msg: LedgerWorkerOutboundMsg = { type: 'rpc-response', id, result, error };
  parentPort!.postMessage(msg);
}

/** Dispatch a store method by name against the closed allowlist. */
function callStore(method: LedgerStoreMethod, args: unknown[]): unknown {
  switch (method) {
    case 'findThreadById':
      return store.findThreadById(args[0] as string);
    case 'listThreads':
      return store.listThreads(args[0] as ConversationListQuery);
    case 'getMessages':
      return store.getMessages(args[0] as string, args[1] as ConversationMessagesQuery | undefined);
    case 'getRecentMessages':
      return store.getRecentMessages(args[0] as string, args[1] as number);
    case 'getMessagesBefore':
      return store.getMessagesBefore(
        args[0] as string,
        args[1] as number,
        args[2] as number,
      );
    case 'countMessages':
      return store.countMessages(args[0] as string);
    case 'hasMessageWithNativeId':
      return store.hasMessageWithNativeId(args[0] as string, args[1] as string);
    case 'upsertThread':
      return store.upsertThread(args[0] as ConversationThreadUpsertInput);
    case 'upsertMessages': {
      store.upsertMessages(args[0] as string, args[1] as ConversationMessageUpsertInput[]);
      return undefined;
    }
    case 'appendMessagesWithThreadTouch':
      return store.appendMessagesWithThreadTouch(args[0] as string, args[1] as AppendMessageInput[]);
    case 'replaceThreadMessagesFromImport':
      return store.replaceThreadMessagesFromImport(
        args[0] as string,
        args[1] as ConversationMessageUpsertInput[],
        args[2] as ConversationSyncCursorUpsertInput | undefined,
      );
    default: {
      const exhaustive: never = method;
      throw new Error(`Unknown ledger store method: ${String(exhaustive)}`);
    }
  }
}

parentPort!.on('message', (msg: LedgerWorkerInboundMsg) => {
  switch (msg.type) {
    case 'store-call': {
      try {
        respond(msg.id, callStore(msg.method, msg.args));
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }
    case 'shutdown': {
      try {
        db.close();
      } catch {
        // best-effort
      }
      respond(msg.id);
      process.exit(0);
      break;
    }
  }
});

// Signal readiness after all synchronous initialisation is complete.
parentPort!.postMessage({ type: 'ready' } satisfies LedgerWorkerOutboundMsg);
