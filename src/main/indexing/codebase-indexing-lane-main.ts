import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import type {
  LaneInboundMessage,
  LaneOutboundMessage,
} from '../background-jobs';
import { RLMContextManager } from '../rlm/context-manager';
import { RLMDatabase } from '../persistence/rlm-database';
import { CodebaseIndexingService } from './indexing-service';
import type { CodebaseIndexingLaneJob } from './codebase-indexing-lane-protocol';

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

  if (!isIndexCodebaseJob(message.payload)) {
    send({
      type: 'job-failed',
      jobId: message.jobId,
      errorMessage: `Unsupported indexing lane job: ${message.jobType}`,
    });
    return;
  }

  if (message.payload.userDataPath) {
    const rlmRoot = path.join(message.payload.userDataPath, 'rlm');
    RLMDatabase.getInstance({
      dbPath: path.join(rlmRoot, 'rlm.db'),
      contentDir: path.join(rlmRoot, 'content'),
    });
  }
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
    const stats = await service.indexCodebase(
      message.payload.storeId ?? `codebase:${message.payload.rootPath}`,
      message.payload.rootPath,
      { force: message.payload.force ?? false },
    );
    const activeJob = activeJobs.get(message.jobId);
    if (activeJob?.cancelled || getServiceProgressStatus(service) === 'cancelled') {
      send({ type: 'job-cancelled', jobId: message.jobId });
      return;
    }
    send({
      type: 'job-succeeded',
      jobId: message.jobId,
      result: {
        rootPath: message.payload.rootPath,
        filesIndexed: stats.filesIndexed,
        chunksCreated: stats.chunksCreated,
        tokensProcessed: stats.tokensProcessed,
        duration: stats.duration,
        errors: stats.errors,
        completedAt: Date.now(),
      },
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
      errorMessage: error instanceof Error ? error.message : String(error),
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

function isIndexCodebaseJob(payload: unknown): payload is CodebaseIndexingLaneJob {
  return (
    typeof payload === 'object'
    && payload !== null
    && (payload as { type?: unknown }).type === 'index-codebase'
    && typeof (payload as { rootPath?: unknown }).rootPath === 'string'
  );
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
