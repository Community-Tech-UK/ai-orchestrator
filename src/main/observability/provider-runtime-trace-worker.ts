/**
 * Provider Runtime Trace Worker
 *
 * Runs in a worker_thread. Receives batched TraceRecord objects, serializes
 * them to NDJSON, and appends to traces.ndjson with size-based rotation.
 *
 * Entrypoint resolution follows the LSP worker pattern:
 *   1. Built: worker-main.js from __dirname
 *   2. Dev:   tsx execArgv
 */

import { parentPort, isMainThread } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as fsP from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  WorkerInboundMessage,
  MetricsMessage,
  TraceRecord,
} from './provider-runtime-trace-protocol';

if (isMainThread) {
  throw new Error('provider-runtime-trace-worker.ts must run in a worker thread');
}

// ── Config ────────────────────────────────────────────────────────────────────

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

const DEFAULT_TRACE_PATH = path.join(
  getElectronUserDataPath() ?? path.join(os.tmpdir(), 'ai-orchestrator'),
  'logs',
  'traces.ndjson',
);

const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024; // 30 MB
const BATCH_INTERVAL_MS = 250;

// ── State ─────────────────────────────────────────────────────────────────────

let traceFilePath = DEFAULT_TRACE_PATH;
let currentFileSizeBytes = 0;
let written = 0;
let rotations = 0;
let errors = 0;

let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue = Promise.resolve();

// ── Rotation ──────────────────────────────────────────────────────────────────

function rotateSyncIfNeeded(): void {
  if (currentFileSizeBytes < MAX_FILE_SIZE_BYTES) return;
  try {
    const rotatedPath = `${traceFilePath}.${Date.now()}.old`;
    if (fs.existsSync(traceFilePath)) {
      fs.renameSync(traceFilePath, rotatedPath);
    }
    currentFileSizeBytes = 0;
    rotations++;
  } catch {
    errors++;
  }
}

// ── File append ───────────────────────────────────────────────────────────────

function flushBatch(): void {
  if (pendingLines.length === 0) return;
  const batch = pendingLines;
  pendingLines = [];
  flushTimer = null;

  const chunk = batch.join('\n') + '\n';
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');

  writeQueue = writeQueue.then(async () => {
    try {
      rotateSyncIfNeeded();
      await fsP.mkdir(path.dirname(traceFilePath), { recursive: true });
      await fsP.appendFile(traceFilePath, chunk, 'utf8');
      currentFileSizeBytes += chunkBytes;
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

// ── File size initialization ──────────────────────────────────────────────────

try {
  const stat = fs.statSync(traceFilePath);
  currentFileSizeBytes = stat.size;
  if (currentFileSizeBytes >= MAX_FILE_SIZE_BYTES) {
    rotateSyncIfNeeded();
  }
} catch {
  currentFileSizeBytes = 0;
}

// ── Message handling ──────────────────────────────────────────────────────────

function sendMetrics(): void {
  const msg: MetricsMessage = {
    type: 'metrics',
    written,
    rotations,
    errors,
    currentFileSizeBytes,
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
