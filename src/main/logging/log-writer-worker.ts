/**
 * Log Writer Worker
 *
 * Runs in a worker_thread. Receives batches of pre-serialized log lines,
 * appends them to app.log, and rotates the file when it exceeds the configured
 * max size. Sync fs is intentional: blocking the worker thread is fine since
 * it never runs on the Electron main event loop.
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkerInboundMessage, WorkerOutboundMessage } from './log-writer-protocol';

let logFile = '';
let maxFileSize = 10 * 1024 * 1024;
let maxFiles = 5;
let currentFileSize = 0;

let written = 0;
let rotations = 0;
let errors = 0;

function post(msg: WorkerOutboundMessage): void {
  parentPort?.postMessage(msg);
}

function rotateLogFile(): void {
  try {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const oldPath = `${logFile}.${i}`;
      const newPath = `${logFile}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === maxFiles - 1) {
          fs.unlinkSync(oldPath);
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }
    if (fs.existsSync(logFile)) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
    currentFileSize = 0;
    rotations++;
  } catch (err) {
    errors++;
    post({ type: 'error', message: `Rotation failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

let metricsTimer: ReturnType<typeof setInterval> | null = null;

parentPort?.on('message', (msg: WorkerInboundMessage) => {
  if (msg.type === 'init') {
    logFile = msg.logFile;
    maxFileSize = msg.maxFileSize;
    maxFiles = msg.maxFiles;
    currentFileSize = msg.currentFileSize;

    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch { /* already exists */ }

    metricsTimer = setInterval(() => {
      post({ type: 'metrics', written, rotations, errors });
    }, 5000);
    if (typeof metricsTimer === 'object' && 'unref' in metricsTimer) {
      (metricsTimer as NodeJS.Timeout).unref();
    }
    return;
  }

  if (msg.type === 'write-lines') {
    const content = msg.lines.join('\n') + '\n';
    const contentSize = Buffer.byteLength(content);

    if (currentFileSize + contentSize > maxFileSize) {
      rotateLogFile();
    }

    try {
      fs.appendFileSync(logFile, content);
      currentFileSize += contentSize;
      written += msg.lines.length;
    } catch (err) {
      errors++;
      post({ type: 'error', message: `Write failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  if (msg.type === 'shutdown') {
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
    post({ type: 'metrics', written, rotations, errors });
    process.exit(0);
  }
});
