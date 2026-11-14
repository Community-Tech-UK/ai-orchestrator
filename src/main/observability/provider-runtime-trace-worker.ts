/**
 * Provider Runtime Trace Worker
 *
 * Runs in a worker_thread. Receives batched TraceRecord objects, serializes
 * them to NDJSON, and appends them to the file named in `workerData` with
 * size-based rotation (see rotating-log-file.ts).
 *
 * The main thread passes the path because a worker cannot reach Electron's
 * `app.getPath('userData')`; guessing it here sent every record to the temp
 * folder, where rotated copies piled up without limit.
 *
 * Entrypoint resolution follows the LSP worker pattern:
 *   1. Built: worker-main.js from __dirname
 *   2. Dev:   tsx execArgv
 */

import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import { appendToRotatingLog } from './rotating-log-file';
import type {
  WorkerInboundMessage,
  MetricsMessage,
  TraceRecord,
  TraceWorkerData,
} from './provider-runtime-trace-protocol';

if (isMainThread) {
  throw new Error('provider-runtime-trace-worker.ts must run in a worker thread');
}

// ── Config ────────────────────────────────────────────────────────────────────

function readTraceFilePath(): string {
  const configured = (workerData as Partial<TraceWorkerData> | null)?.traceFilePath;
  if (!configured) {
    throw new Error('provider-runtime-trace-worker needs workerData.traceFilePath');
  }
  return configured;
}

const traceFilePath = readTraceFilePath();

const BATCH_INTERVAL_MS = 250;

// ── State ─────────────────────────────────────────────────────────────────────

let written = 0;
let rotations = 0;
let errors = 0;

let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue = Promise.resolve();

// ── File append ───────────────────────────────────────────────────────────────

function flushBatch(): void {
  if (pendingLines.length === 0) return;
  const batch = pendingLines;
  pendingLines = [];
  flushTimer = null;

  const chunk = batch.join('\n') + '\n';

  writeQueue = writeQueue.then(async () => {
    try {
      if (await appendToRotatingLog(traceFilePath, chunk)) rotations++;
      written += batch.length;
    } catch {
      errors++;
    }
  });
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushBatch, BATCH_INTERVAL_MS);
}

// ── Record serialization ──────────────────────────────────────────────────────

function serializeRecord(record: TraceRecord): string {
  return JSON.stringify(record);
}

// ── Message handling ──────────────────────────────────────────────────────────

function sendMetrics(): void {
  const msg: MetricsMessage = {
    type: 'metrics',
    written,
    rotations,
    errors,
  };
  parentPort!.postMessage(msg);
}

parentPort!.on('message', (msg: WorkerInboundMessage) => {
  switch (msg.type) {
    case 'write-records':
      for (const record of msg.records) {
        pendingLines.push(serializeRecord(record));
      }
      scheduleFlush();
      sendMetrics();
      break;

    case 'shutdown':
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushBatch();
      writeQueue.then(() => process.exit(0)).catch(() => process.exit(1));
      break;
  }
});
