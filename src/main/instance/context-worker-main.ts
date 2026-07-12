/**
 * Context Worker — runs in a child process or worker_thread.
 *
 * Owns a fresh InstanceContextManager (and therefore its own RLMContextManager,
 * UnifiedMemoryController, VectorStore, EmbeddingService, and better-sqlite3
 * connection). No Database object is shared across process/thread boundaries.
 *
 * The RLM database is pre-initialised with explicit paths from workerData so
 * the worker never calls app.getPath() at a time when the Electron app object
 * might not be ready.
 *
 * Entrypoint resolution follows the LSP worker precedent:
 *   1. Built:  context-worker-main.js from __dirname
 *   2. Dev:    tsx execArgv
 */

// Must be first — register @contracts/@sdk/@shared path aliases for THIS worker
// thread. Worker threads are separate module realms, so they do not inherit the
// main thread's Module._resolveFilename patch; without this, transitive
// `@contracts/*` imports (e.g. via skill-loader) fail with "Cannot find module".
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRegisterAliases(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../register-aliases');
    return;
  } catch (error) {
    const message = errorMessage(error);
    if (!message.includes('../register-aliases')) {
      throw error;
    }
  }
  try {
    // Dev path: the entrypoint is TypeScript and no compiled
    // register-aliases.js exists yet. The worker is launched with tsx support.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../register-aliases.ts');
  } catch (error) {
    if (
      process.env['VITEST'] === 'true' &&
      errorMessage(error).includes('__dirname is not defined in ES module scope')
    ) {
      return;
    }
    throw error;
  }
}

requireRegisterAliases();

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import { getElectronParentPort } from '../runtime/electron-parent-port';
import { InstanceContextManager } from './instance-context';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import { buildMcpRuntimeToolContextSelection } from '../mcp/mcp-runtime-tool-context';
import { RLMDatabase } from '../persistence/rlm-database';
import { getPolicyAdapter } from '../observation/policy-adapter';
import { buildProjectMemoryBriefInWorker } from '../memory/project-memory-brief-worker';
import {
  loadHabitTrackerStateSnapshot,
  loadMetricsCollectorStateSnapshot,
  loadOutcomeTrackerStateSnapshot,
} from '../learning/learning-state-snapshots';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  ContextWorkerInboundMsg,
  ContextWorkerOutboundMsg,
  ContextWorkerInstanceSnapshot,
  ContextWorkerOutputMsg,
} from './context-worker-protocol';

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

// ── Transport ─────────────────────────────────────────────────────────────────

interface ContextWorkerTransport {
  postMessage(message: ContextWorkerOutboundMsg): void;
  onMessage(listener: (message: ContextWorkerInboundMsg) => void): void;
}

function createTransport(): ContextWorkerTransport {
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
        electronPort.on('message', (event) => listener(event.data as ContextWorkerInboundMsg));
      },
    };
  }
  if (isMainThread && typeof process.send === 'function') {
    process.once('disconnect', () => process.exit(0));
    return {
      postMessage: (message) => process.send?.(message),
      onMessage: (listener) => {
        process.on('message', (message) => listener(message as ContextWorkerInboundMsg));
      },
    };
  }
  throw new Error(
    'context-worker-main must run in a worker thread, utility process, or child process',
  );
}

const transport = createTransport();

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
  transport.postMessage(msg);
}

function exitAfterMessageFlush(): void {
  setImmediate(() => process.exit(0));
}

// ── Message routing ───────────────────────────────────────────────────────────

transport.onMessage((msg: ContextWorkerInboundMsg) => {
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

    case 'build-wake-context-text': {
      try {
        respond(
          msg.id,
          getWakeContextBuilder().getWakeUpText(msg.wing, {
            bypassCache: msg.bypassCache ?? false,
          }),
        );
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'build-observation-context': {
      try {
        respond(
          msg.id,
          await getPolicyAdapter().buildObservationContext(
            msg.taskContext,
            msg.instanceId,
            msg.taskType,
          ),
        );
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'build-project-memory-brief': {
      try {
        respond(
          msg.id,
          await buildProjectMemoryBriefInWorker(msg.request),
        );
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'build-mcp-runtime-tool-context': {
      try {
        respond(
          msg.id,
          buildMcpRuntimeToolContextSelection(msg.snapshot, {
            query: msg.query,
            maxTools: msg.maxTools,
          }),
        );
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'load-outcome-tracker-state': {
      try {
        respond(msg.id, loadOutcomeTrackerStateSnapshot(msg.maxExperiences));
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'load-metrics-collector-state': {
      try {
        respond(msg.id, loadMetricsCollectorStateSnapshot());
      } catch {
        respond(msg.id, null);
      }
      break;
    }

    case 'load-habit-tracker-state': {
      try {
        respond(msg.id, loadHabitTrackerStateSnapshot(msg.trackingWindowDays));
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

    case 'reload-rlm-persistence': {
      try {
        await contextManager.reloadRlmPersistence();
        respond(msg.id);
      } catch (err) {
        respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
      }
      break;
    }

    case 'shutdown': {
      respond(msg.id);
      exitAfterMessageFlush();
      break;
    }
  }
}

// Signal readiness after all synchronous initialisation is complete.
transport.postMessage({ type: 'ready' } satisfies ContextWorkerOutboundMsg);
