import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import type {
  LaneInboundMessage,
  LaneOutboundMessage,
} from '../background-jobs';
import { RLMContextManager } from '../rlm/context-manager';
import { RLMDatabase } from '../persistence/rlm-database';
import { CodebaseIndexingService } from './indexing-service';
import {
  parseCodebaseIndexingLaneJob,
  type CodebaseIndexingFileOutcome,
  type CodebaseIndexingLaneJob,
} from './codebase-indexing-lane-protocol';
import { registerWorkerEventForwarding } from '../instance/context-worker-event-forwarding';

type RunJobMessage = Extract<LaneInboundMessage, { type: 'run-job' }> & {
  payload: CodebaseIndexingLaneJob;
};

interface ElectronParentPort {
  on(event: 'message', listener: (event: unknown) => void): void;
  postMessage(message: LaneOutboundMessage): void;
}

interface ActiveJob {
  service: CodebaseIndexingService;
  cancelled: boolean;
}

const LANE = 'indexing' as const;
const HEARTBEAT_INTERVAL_MS = 5_000;
const activeJobs = new Map<string, ActiveJob>();
let heartbeatTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let exitScheduled = false;

function send(message: LaneOutboundMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  const electronParentPort = getElectronParentPort();
  if (electronParentPort) {
    electronParentPort.postMessage(message);
    return;
  }
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function sendHeartbeat(): void {
  send({ type: 'heartbeat', lane: LANE, timestamp: Date.now() });
}

let workerEventForwardingRegistered = false;

/**
 * LT-207: this lane constructs its own worker-local `RLMContextManager`
 * (`indexCodebase()` → `CodebaseIndexingService.addSection()` →
 * `this.contextManager.addSection(...)`), so `section:added` fired here is
 * invisible outside this process without an explicit transport hop. It uses
 * `registerWorkerEventForwarding()` to normalize and post DTOs; main-side
 * dispatch in `context-worker-event-relay.ts` publishes them to the shared,
 * manager-independent relay.
 *
 * Must run AFTER `RLMDatabase.getInstance()` has been configured with this
 * job's `userDataPath`. This call site then resolves the worker-local manager
 * and injects it into forwarding. Constructing the manager earlier would let
 * its eager `getRLMDatabase()` call pin the process to the fallback path.
 * Registration remains guarded so repeated jobs attach listeners only once.
 */
function ensureWorkerEventForwarding(): void {
  if (workerEventForwardingRegistered) return;
  workerEventForwardingRegistered = true;
  registerWorkerEventForwarding({
    postMessage: (message) => send({ type: 'worker-event', message }),
  }, RLMContextManager.getInstance());
}

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

function stopHeartbeatIfIdle(): void {
  if (activeJobs.size > 0 || !heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function handleRun(message: RunJobMessage): Promise<void> {
  if (shuttingDown) {
    send({
      type: 'job-failed',
      jobId: message.jobId,
      errorMessage: 'Indexing lane is shutting down',
    });
    return;
  }

  let job: CodebaseIndexingLaneJob;
  try {
    job = parseCodebaseIndexingLaneJob(message.payload);
    if (message.jobType !== job.type) {
      throw new Error(
        `Indexing lane job type ${message.jobType} does not match payload type ${job.type}`,
      );
    }
  } catch (error) {
    const payloadType = typeof message.payload === 'object' && message.payload !== null
      ? (message.payload as { type?: unknown }).type
      : undefined;
    const errorMessage = payloadType === message.jobType
      && !isKnownJobType(payloadType)
      ? `Unsupported indexing lane job: ${message.jobType}`
      : toBoundedErrorMessage(error);
    send({
      type: 'job-failed',
      jobId: message.jobId,
      errorMessage,
    });
    return;
  }

  if (job.userDataPath) {
    const rlmRoot = path.join(job.userDataPath, 'rlm');
    RLMDatabase.getInstance({
      dbPath: path.join(rlmRoot, 'rlm.db'),
      contentDir: path.join(rlmRoot, 'content'),
    });
  }
  ensureWorkerEventForwarding();
  RLMContextManager.getInstance().reloadFromPersistence();
  const service = new CodebaseIndexingService();
  activeJobs.set(message.jobId, { service, cancelled: false });
  ensureHeartbeat();
  send({
    type: 'job-started',
    jobId: message.jobId,
    startedAt: Date.now(),
  });
  sendHeartbeat();
  service.on('progress', (progress) => {
    send({
      type: 'job-progress',
      jobId: message.jobId,
      progress: {
        phase: progress.status,
        completed: progress.processedFiles,
        total: progress.totalFiles,
        message: progress.currentFile,
      },
    });
    sendHeartbeat();
  });

  try {
    const result = await executeJob(service, job);
    const activeJob = activeJobs.get(message.jobId);
    if (activeJob?.cancelled || getServiceProgressStatus(service) === 'cancelled') {
      send({ type: 'job-cancelled', jobId: message.jobId });
      return;
    }
    send({
      type: 'job-succeeded',
      jobId: message.jobId,
      result,
    });
  } catch (error) {
    const activeJob = activeJobs.get(message.jobId);
    if (activeJob?.cancelled) {
      send({ type: 'job-cancelled', jobId: message.jobId });
      return;
    }
    send({
      type: 'job-failed',
      jobId: message.jobId,
      errorMessage: toBoundedErrorMessage(error),
    });
  } finally {
    activeJobs.delete(message.jobId);
    stopHeartbeatIfIdle();
    exitIfShutdownIdle();
  }
}

function handleMessage(message: LaneInboundMessage): void {
  if (message.type === 'run-job') {
    void handleRun(message as RunJobMessage);
    return;
  }
  if (message.type === 'cancel-job') {
    const activeJob = activeJobs.get(message.jobId);
    if (activeJob) {
      activeJob.cancelled = true;
      activeJob.service.cancel();
    }
    return;
  }
  if (message.type === 'get-status') {
    sendHeartbeat();
    return;
  }
  if (message.type === 'shutdown') {
    shuttingDown = true;
    for (const activeJob of activeJobs.values()) {
      activeJob.cancelled = true;
      activeJob.service.cancel();
    }
    exitIfShutdownIdle();
  }
}

function exitIfShutdownIdle(): void {
  if (!shuttingDown || activeJobs.size > 0 || exitScheduled) return;
  exitScheduled = true;
  stopHeartbeatIfIdle();
  process.exit(0);
}

async function executeJob(
  service: CodebaseIndexingService,
  job: CodebaseIndexingLaneJob,
): Promise<unknown> {
  switch (job.type) {
    case 'index-codebase': {
      const stats = await service.indexCodebase(
        job.storeId ?? `codebase:${job.rootPath}`,
        job.rootPath,
        { force: job.force ?? false },
      );
      return {
        rootPath: job.rootPath,
        filesIndexed: stats.filesIndexed,
        chunksCreated: stats.chunksCreated,
        tokensProcessed: stats.tokensProcessed,
        duration: stats.duration,
        errors: stats.errors.slice(0, 256).map((error) => ({
          file: error.file.slice(0, 4_096),
          error: error.error.slice(0, 16_384),
          recoverable: error.recoverable,
        })),
        completedAt: Date.now(),
      };
    }
    case 'index-file':
      await service.indexFile(job.storeId, job.filePath);
      return undefined;
    case 'remove-file':
      await service.removeFile(job.storeId, job.filePath);
      return undefined;
    case 'get-stats':
      return service.getStats(job.storeId);
    case 'clear-legacy-store':
      await service.clearLegacyCodebaseStore(job.storeId);
      return undefined;
    case 'sync-files':
      return {
        outcomes: await syncFiles(service, job.storeId, job.deletions, job.upserts),
      };
  }
}

async function syncFiles(
  service: CodebaseIndexingService,
  storeId: string,
  deletions: string[],
  upserts: string[],
): Promise<CodebaseIndexingFileOutcome[]> {
  const outcomes: CodebaseIndexingFileOutcome[] = [];
  for (const filePath of deletions) {
    outcomes.push(await runFileOperation('removed', filePath, () => (
      service.removeFile(storeId, filePath)
    )));
  }
  for (const filePath of upserts) {
    outcomes.push(await runFileOperation('indexed', filePath, () => (
      service.indexFile(storeId, filePath)
    )));
  }
  return outcomes;
}

async function runFileOperation(
  operation: CodebaseIndexingFileOutcome['operation'],
  filePath: string,
  run: () => Promise<void>,
): Promise<CodebaseIndexingFileOutcome> {
  try {
    await run();
    return { operation, filePath, success: true };
  } catch (error) {
    return {
      operation,
      filePath,
      success: false,
      error: toBoundedErrorMessage(error),
    };
  }
}

function toBoundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 16_384);
}

function isKnownJobType(value: unknown): value is CodebaseIndexingLaneJob['type'] {
  return value === 'index-codebase'
    || value === 'index-file'
    || value === 'remove-file'
    || value === 'get-stats'
    || value === 'clear-legacy-store'
    || value === 'sync-files';
}

function getServiceProgressStatus(service: CodebaseIndexingService): string | undefined {
  return typeof service.getProgress === 'function'
    ? service.getProgress().status
    : undefined;
}

function getElectronParentPort(): ElectronParentPort | null {
  const candidate = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
  if (candidate && typeof candidate.on === 'function' && typeof candidate.postMessage === 'function') {
    return candidate;
  }
  return null;
}

function unwrapInboundMessage(message: unknown): LaneInboundMessage {
  if (
    typeof message === 'object'
    && message !== null
    && 'data' in message
  ) {
    return (message as { data: LaneInboundMessage }).data;
  }
  return message as LaneInboundMessage;
}

if (parentPort) {
  parentPort.on('message', (message) => handleMessage(message as LaneInboundMessage));
} else if (getElectronParentPort()) {
  getElectronParentPort()?.on('message', (message) => handleMessage(unwrapInboundMessage(message)));
} else {
  process.on('message', (message) => handleMessage(message as LaneInboundMessage));
}

send({ type: 'ready', lane: LANE });
