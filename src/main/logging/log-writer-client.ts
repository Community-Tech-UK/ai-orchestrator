/**
 * Log Writer Client
 *
 * Main-process client for the log-writer worker thread.
 * Accepts pre-serialized JSON log lines, batches them, and posts to the worker.
 * Falls back to a direct async write queue when the worker cannot be started.
 */

import { existsSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkerOutboundMessage } from './log-writer-protocol';

const BATCH_SIZE = 100;
const BATCH_FLUSH_INTERVAL_MS = 250;

function createWorker(): Worker | null {
  try {
    const jsEntry = path.join(__dirname, 'log-writer-worker.js');
    if (existsSync(jsEntry)) return new Worker(jsEntry);
    const tsEntry = path.join(__dirname, 'log-writer-worker.ts');
    if (existsSync(tsEntry)) return new Worker(tsEntry, { execArgv: ['--import', 'tsx'] });
    return null;
  } catch {
    return null;
  }
}

export interface LogWriterClientOptions {
  logFile: string;
  maxFileSize: number;
  maxFiles: number;
  currentFileSize: number;
  workerFactory?: () => Worker | null;
}

export class LogWriterClient {
  private worker: Worker | null = null;
  private pendingLines: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackQueue = Promise.resolve();
  private currentFallbackSize: number;
  private workerErrors = 0;
  private workerWritten = 0;
  private workerRotations = 0;

  private readonly logFile: string;
  private readonly maxFileSize: number;
  private readonly maxFiles: number;

  constructor(opts: LogWriterClientOptions) {
    this.logFile = opts.logFile;
    this.maxFileSize = opts.maxFileSize;
    this.maxFiles = opts.maxFiles;
    this.currentFallbackSize = opts.currentFileSize;

    const factory = opts.workerFactory ?? createWorker;
    this.worker = factory();

    if (this.worker) {
      this.worker.on('message', (msg: WorkerOutboundMessage) => {
        if (msg.type === 'metrics') {
          this.workerWritten = msg.written;
          this.workerRotations = msg.rotations;
          this.workerErrors = msg.errors;
        }
      });
      this.worker.on('error', () => {
        this.workerErrors++;
        this.worker = null;
      });
      this.worker.on('exit', (code) => {
        if (code !== 0) this.workerErrors++;
        this.worker = null;
      });

      this.worker.postMessage({
        type: 'init',
        logFile: this.logFile,
        maxFileSize: this.maxFileSize,
        maxFiles: this.maxFiles,
        currentFileSize: opts.currentFileSize,
      });
    }
  }

  writeLine(line: string): void {
    if (this.worker) {
      this.pendingLines.push(line);
      if (this.pendingLines.length >= BATCH_SIZE) {
        this.flushPending();
        return;
      }
      if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => this.flushPending(), BATCH_FLUSH_INTERVAL_MS);
        if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
          (this.flushTimer as NodeJS.Timeout).unref();
        }
      }
    } else {
      this.writeLineFallback(line);
    }
  }

  metrics(): { workerErrors: number; workerWritten: number; workerRotations: number } {
    return {
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
    if (this.worker) {
      this.worker.postMessage({ type: 'shutdown' });
      await new Promise<void>((resolve) => {
        this.worker!.once('exit', () => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
    }
    await this.fallbackQueue;
  }

  private flushPending(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingLines.length === 0) return;
    if (!this.worker) {
      for (const line of this.pendingLines) {
        this.writeLineFallback(line);
      }
      this.pendingLines = [];
      return;
    }
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.worker.postMessage({ type: 'write-lines', lines });
  }

  private writeLineFallback(line: string): void {
    const content = line + '\n';
    const contentSize = Buffer.byteLength(content);
    this.fallbackQueue = this.fallbackQueue.then(async () => {
      try {
        if (this.currentFallbackSize + contentSize > this.maxFileSize) {
          await this.rotateFallback();
        }
        await fsPromises.appendFile(this.logFile, content);
        this.currentFallbackSize += contentSize;
      } catch { /* suppress write errors */ }
    });
  }

  private async rotateFallback(): Promise<void> {
    try {
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const oldPath = `${this.logFile}.${i}`;
        const newPath = `${this.logFile}.${i + 1}`;
        try {
          await fsPromises.access(oldPath);
          if (i === this.maxFiles - 1) {
            await fsPromises.unlink(oldPath);
          } else {
            await fsPromises.rename(oldPath, newPath);
          }
        } catch { /* file doesn't exist */ }
      }
      try {
        await fsPromises.rename(this.logFile, `${this.logFile}.1`);
      } catch { /* file doesn't exist */ }
      this.currentFallbackSize = 0;
    } catch { /* rotation failed */ }
  }
}
