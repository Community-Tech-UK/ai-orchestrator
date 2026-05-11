/**
 * Context Worker — runs in a worker_thread.
 *
 * Owns a fresh InstanceContextManager (and therefore its own RLMContextManager,
 * UnifiedMemoryController, VectorStore, EmbeddingService, and better-sqlite3
 * connection). No Database object is shared across thread boundaries.
 *
 * The RLM database is pre-initialised with explicit paths from workerData so
 * the worker never calls app.getPath() at a time when the Electron app object
 * might not be ready.
 *
 * Entrypoint resolution follows the LSP worker precedent:
 *   1. Built:  context-worker-main.js from __dirname
 *   2. Dev:    tsx execArgv
 */

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstanceContextManager } from './instance-context';
import { RLMDatabase } from '../persistence/rlm-database';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  ContextWorkerInboundMsg,
  ContextWorkerOutboundMsg,
  ContextWorkerInstanceSnapshot,
  ContextWorkerOutputMsg,
} from './context-worker-protocol';

if (isMainThread) {
  throw new Error('context-worker-main must run in a worker thread');
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

// ── RLM database pre-init ─────────────────────────────────────────────────────

// Pre-initialise with explicit paths so RLMContextManager.getInstance() picks
// up the correct singleton (with busy_timeout) on first access.
RLMDatabase.getInstance({
  dbPath: path.join(userDataPath, 'rlm', 'rlm.db'),
  contentDir: path.join(userDataPath, 'rlm', 'content'),
});

// ── Context manager ───────────────────────────────────────────────────────────

const contextManager = new InstanceContextManager();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInstance(snap: ContextWorkerInstanceSnapshot): Instance {
  return {
    id: snap.id,
    sessionId: snap.sessionId ?? `session-${snap.id}`,
    parentId: snap.parentId ?? null,
    contextUsage: snap.contextUsage ?? { used: 0, total: 0, percentage: 0 },
    outputBuffer: [],
    displayName: snap.id,
    createdAt: Date.now(),
    historyThreadId: snap.id,
    childrenIds: [],
    supervisorNodeId: '',
    depth: 0,
  } as unknown as Instance;
}

function makeOutputMessage(msg: ContextWorkerOutputMsg): OutputMessage {
  return {
    id: msg.id,
    type: msg.type,
    content: msg.content ?? '',
    timestamp: msg.timestamp,
    metadata: msg.metadata,
  } as unknown as OutputMessage;
}

function respond(id: number, result?: unknown, error?: string): void {
  const msg: ContextWorkerOutboundMsg = { type: 'rpc-response', id, result, error };
  parentPort!.postMessage(msg);
}

// ── Message routing ───────────────────────────────────────────────────────────

parentPort!.on('message', (msg: ContextWorkerInboundMsg) => {
  void handleMessage(msg);
});

async function handleMessage(msg: ContextWorkerInboundMsg): Promise<void> {
  switch (msg.type) {
    case 'initialize-rlm': {
      try {
        await contextManager.initializeRlm(makeInstance(msg.snapshot));
        respond(msg.id);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'end-rlm-session': {
      contextManager.endRlmSession(msg.instanceId);
      break;
    }

    case 'ingest-rlm': {
      contextManager.ingestToRLM(msg.instanceId, makeOutputMessage(msg.message));
      break;
    }

    case 'ingest-unified-memory': {
      contextManager.ingestToUnifiedMemory(
        makeInstance(msg.snapshot),
        makeOutputMessage(msg.message),
      );
      break;
    }

    case 'build-rlm-context': {
      try {
        const result = await contextManager.buildRlmContext(
          msg.instanceId,
          msg.query,
          msg.maxTokens,
          msg.topK,
        );
        respond(msg.id, result);
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'build-unified-memory-context': {
      try {
        const result = await contextManager.buildUnifiedMemoryContext(
          makeInstance(msg.snapshot),
          msg.query,
          msg.taskId,
          msg.maxTokens,
        );
        respond(msg.id, result);
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'compact-context': {
      try {
        // Pass a minimal instance with an empty outputBuffer — the main-process
        // client is responsible for trimming the real outputBuffer after this
        // RPC completes.
        const fakeInstance = makeInstance(msg.snapshot);
        await contextManager.compactContext(msg.snapshot.id, fakeInstance);
        respond(msg.id);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'ingest-initial-output': {
      try {
        await contextManager.ingestInitialOutputToRlm(
          makeInstance(msg.snapshot),
          msg.messages.map(makeOutputMessage),
        );
        respond(msg.id);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'get-stats': {
      respond(msg.id, {});
      break;
    }

    case 'shutdown': {
      respond(msg.id);
      process.exit(0);
      break;
    }
  }
}

// Signal readiness after all synchronous initialisation is complete.
parentPort!.postMessage({ type: 'ready' } satisfies ContextWorkerOutboundMsg);
