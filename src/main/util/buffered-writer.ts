/**
 * Buffered Writer — coalesces file writes and flushes in batches.
 *
 * Replaces blocking fs.writeFileSync calls with batched async writes,
 * preventing event loop stalls in persistence-heavy paths.
 *
 * Features:
 * - Write deduplication (same-path overwrites keep only latest)
 * - Append coalescing (multiple appends merged into one)
 * - Overflow protection (auto-flush at buffer limit)
 * - Graceful shutdown (flush + stop timer)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('BufferedWriter');

export interface BufferedWriterOptions {
  /** Flush interval in milliseconds. Default: 1000 */
  flushIntervalMs?: number;
  /** Max number of buffered entries before auto-flush. Default: 100 */
  maxBufferSize?: number;
  /** Max total bytes before auto-flush. Default: 1MB */
  maxBufferBytes?: number;
}

interface WriteEntry {
  filePath: string;
  content: string;
  type: 'write' | 'append';
}

export class BufferedWriter {
  private writes = new Map<string, WriteEntry>();
  private appends = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalBytes = 0;
  private isShutdown = false;
  private flushPromise: Promise<void> | null = null;

  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly maxBufferBytes: number;

  constructor(options: BufferedWriterOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    if (this.timer.unref) this.timer.unref();
  }

  /** Buffer a write (overwrites previous buffered write to same path). */
  write(filePath: string, content: string): void {
    if (this.isShutdown) return;

    const prev = this.writes.get(filePath);
    if (prev) {
      this.totalBytes -= Buffer.byteLength(prev.content, 'utf-8');
    }

    this.writes.set(filePath, { filePath, content, type: 'write' });
    this.totalBytes += Buffer.byteLength(content, 'utf-8');

    this.maybeAutoFlush();
  }

  /** Buffer an append (coalesces with previous appends to same path). */
  append(filePath: string, content: string): void {
    if (this.isShutdown) return;

    const existing = this.appends.get(filePath) ?? '';
    this.appends.set(filePath, existing + content);
    this.totalBytes += Buffer.byteLength(content, 'utf-8');

    this.maybeAutoFlush();
  }

  /** Immediately flush all buffered writes. */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
    }

    this.flushPromise = this.doFlush();
    await this.flushPromise;
    this.flushPromise = null;
  }

  /** Flush remaining writes and stop the timer. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.flush();
  }

  /** Return current buffer statistics. */
  stats(): { pendingWrites: number; pendingAppends: number; totalBufferedBytes: number } {
    return {
      pendingWrites: this.writes.size,
      pendingAppends: this.appends.size,
      totalBufferedBytes: this.totalBytes,
    };
  }

  private async doFlush(): Promise<void> {
    const writes = new Map(this.writes);
    const appends = new Map(this.appends);
    this.writes.clear();
    this.appends.clear();
    this.totalBytes = 0;

    const tasks: Promise<void>[] = [];

    for (const [filePath, entry] of writes) {
      tasks.push(this.safeWrite(filePath, entry.content));
    }

    for (const [filePath, content] of appends) {
      tasks.push(this.safeAppend(filePath, content));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async safeWrite(filePath: string, content: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error('Buffered write failed', e instanceof Error ? e : new Error(String(e)), { filePath });
    }
  }

  private async safeAppend(filePath: string, content: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error('Buffered append failed', e instanceof Error ? e : new Error(String(e)), { filePath });
    }
  }

  private maybeAutoFlush(): void {
    const entryCount = this.writes.size + this.appends.size;
    if (entryCount >= this.maxBufferSize || this.totalBytes >= this.maxBufferBytes) {
      void this.flush();
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: BufferedWriter | null = null;

export function getBufferedWriter(): BufferedWriter {
  if (!instance) {
    instance = new BufferedWriter();
  }
  return instance;
}

/** Flush and stop the global writer. Call during app shutdown. */
export async function shutdownBufferedWriter(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

/** Reset for testing. */
export function _resetBufferedWriterForTesting(): void {
  if (instance) {
    clearInterval((instance as unknown as { timer: ReturnType<typeof setInterval> }).timer);
    instance = null;
  }
}
