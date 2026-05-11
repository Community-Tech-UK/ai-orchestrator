/**
 * Provider Runtime Trace Sink
 *
 * Main-process client for the provider runtime trace worker.
 * Accepts clone-safe ProviderRuntimeEventEnvelope records, batches them, and
 * posts to the worker thread for NDJSON serialization and file append.
 *
 * Falls back to a no-op if the worker cannot be started.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { BoundedAsyncQueue } from '../runtime/bounded-async-queue';
import { getLogger } from '../logging/logger';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type {
  TraceRecord,
  WorkerOutboundMessage,
} from './provider-runtime-trace-protocol';

const logger = getLogger('ProviderRuntimeTraceSink');

const BATCH_SIZE = 50;
const BATCH_FLUSH_INTERVAL_MS = 200;

export interface ProviderRuntimeTraceSinkMetrics {
  enqueued: number;
  dropped: number;
  workerErrors: number;
  workerWritten: number;
  workerRotations: number;
}

function toTraceRecord(envelope: ProviderRuntimeEventEnvelope): TraceRecord {
  const event = envelope.event;
  const record: TraceRecord = {
    eventId: envelope.eventId,
    seq: envelope.seq,
    timestamp: envelope.timestamp,
    provider: envelope.provider,
    instanceId: envelope.instanceId,
    sessionId: envelope.sessionId,
    model: envelope.model,
    kind: event.kind,
  };

  // Attach compact diagnostic attributes for error / complete / context events.
  if (event.kind === 'error') {
    record.attributes = {
      'error.message': event.message,
      ...(event.stopReason ? { 'error.stop_reason': event.stopReason } : {}),
    };
  } else if (event.kind === 'complete') {
    record.attributes = {
      'complete.stop_reason': event.stopReason ?? 'unknown',
    };
  } else if (event.kind === 'context') {
    record.attributes = {
      'context.used': event.used,
      'context.total': event.total,
      ...(event.percentage !== undefined ? { 'context.percentage': event.percentage } : {}),
    };
  }

  return record;
}

function createWorker(): Worker | null {
  try {
    const jsEntry = path.join(__dirname, 'provider-runtime-trace-worker.js');
    if (existsSync(jsEntry)) {
      return new Worker(jsEntry);
    }
    const tsEntry = path.join(__dirname, 'provider-runtime-trace-worker.ts');
    if (existsSync(tsEntry)) {
      return new Worker(tsEntry, { execArgv: ['--import', 'tsx'] });
    }
    logger.warn('Provider runtime trace worker entrypoint not found; trace writes disabled');
    return null;
  } catch (err) {
    logger.warn('Failed to start provider runtime trace worker', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export class ProviderRuntimeTraceSink {
  private worker: Worker | null = null;
  private pendingRecords: TraceRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private workerErrors = 0;
  private workerWritten = 0;
  private workerRotations = 0;

  private readonly queue: BoundedAsyncQueue<TraceRecord[]>;

  constructor(workerFactory?: () => Worker | null) {
    this.worker = workerFactory ? workerFactory() : createWorker();

    if (this.worker) {
      this.worker.on('message', (msg: WorkerOutboundMessage) => {
        if (msg.type === 'metrics') {
          this.workerWritten = msg.written;
          this.workerRotations = msg.rotations;
          this.workerErrors = msg.errors;
        } else if (msg.type === 'error') {
          this.workerErrors++;
          logger.warn('Trace worker error', { message: msg.message });
        }
      });
      this.worker.on('error', (err) => {
        this.workerErrors++;
        logger.warn('Trace worker crashed', { error: err.message });
        this.worker = null;
      });
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          this.workerErrors++;
          logger.warn('Trace worker exited unexpectedly', { code });
        }
        this.worker = null;
      });
    }

    this.queue = new BoundedAsyncQueue<TraceRecord[]>({
      name: 'provider-trace-sink',
      maxSize: 500,
      concurrency: 1,
      process: (batch) => this.postBatch(batch),
      onDrop: (_, reason) => {
        if (reason === 'capacity') {
          logger.debug('Provider trace sink dropped batch (capacity)');
        }
      },
    });
  }

  enqueue(envelope: ProviderRuntimeEventEnvelope): void {
    const record = toTraceRecord(envelope);
    this.pendingRecords.push(record);

    if (this.pendingRecords.length >= BATCH_SIZE) {
      this.flushPending();
      return;
    }

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushPending(), BATCH_FLUSH_INTERVAL_MS);
      if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
        (this.flushTimer as NodeJS.Timeout).unref();
      }
    }
  }

  metrics(): ProviderRuntimeTraceSinkMetrics {
    const qm = this.queue.metrics();
    return {
      enqueued: qm.processed + qm.queued + qm.inFlight,
      dropped: qm.dropped,
      workerErrors: this.workerErrors,
      workerWritten: this.workerWritten,
      workerRotations: this.workerRotations,
    };
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPending();
    await this.queue.shutdown({ drain: true });
    if (this.worker) {
      this.worker.postMessage({ type: 'shutdown' });
      await new Promise<void>((resolve) => {
        this.worker!.once('exit', () => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
    }
  }

  private flushPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingRecords.length === 0) return;
    const batch = this.pendingRecords;
    this.pendingRecords = [];
    this.queue.enqueue(batch);
  }

  private postBatch(batch: TraceRecord[]): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'write-records', records: batch });
  }
}

let sharedInstance: ProviderRuntimeTraceSink | null = null;

export function getProviderRuntimeTraceSink(): ProviderRuntimeTraceSink {
  if (!sharedInstance) {
    sharedInstance = new ProviderRuntimeTraceSink();
  }
  return sharedInstance;
}

export function _resetProviderRuntimeTraceSinkForTesting(): void {
  sharedInstance = null;
}
