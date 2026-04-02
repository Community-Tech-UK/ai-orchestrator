/**
 * Output Persistence Manager
 *
 * Intercepts large CLI tool outputs before they are inserted into the context
 * window. Outputs exceeding configurable per-tool thresholds are saved to disk;
 * the context receives a compact preview + retrieval marker instead.
 *
 * Default thresholds:
 *   grep / search tools  → 20 K chars
 *   web_fetch            → 100 K chars
 *   all other tools      → 50 K chars
 *
 * Cache location: <userData>/output-cache/<sha256>.txt
 * Auto-cleanup: files older than 24 hours are removed by cleanup().
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('OutputPersistenceManager');

const PREVIEW_HEAD_CHARS = 2000;
const PREVIEW_TAIL_CHARS = 1000;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_THRESHOLDS: Record<string, number> = {
  grep: 20_000,
  search: 20_000,
  web_fetch: 100_000,
  default: 50_000,
};

export interface OutputPersistenceConfig {
  thresholds?: Record<string, number>;
}

export class OutputPersistenceManager {
  private static instance: OutputPersistenceManager | null = null;

  private thresholds: Record<string, number> = { ...DEFAULT_THRESHOLDS };
  private cacheDir: string;

  private constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'output-cache');
  }

  static getInstance(): OutputPersistenceManager {
    if (!OutputPersistenceManager.instance) {
      OutputPersistenceManager.instance = new OutputPersistenceManager();
    }
    return OutputPersistenceManager.instance;
  }

  static _resetForTesting(): void {
    OutputPersistenceManager.instance = null;
  }

  /** Override default thresholds or add new per-tool thresholds. */
  configure(config: OutputPersistenceConfig): void {
    if (config.thresholds) {
      this.thresholds = { ...this.thresholds, ...config.thresholds };
    }
  }

  /**
   * If `output` exceeds the threshold for `toolName`, persist the full content
   * to disk and return a truncated preview with a retrieval marker.
   * Otherwise returns `output` unchanged.
   */
  async maybeExternalize(toolName: string, output: string): Promise<string> {
    const threshold = this.thresholds[toolName] ?? this.thresholds['default'];

    if (output.length <= threshold) {
      return output;
    }

    const hash = this.sha256(output);
    const filePath = path.join(this.cacheDir, `${hash}.txt`);

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(filePath, output, 'utf8');
    } catch (err) {
      logger.error('Failed to persist large output to cache', err as Error, { toolName, hash });
      return output;
    }

    const head = output.slice(0, PREVIEW_HEAD_CHARS);
    const tail = output.slice(-PREVIEW_TAIL_CHARS);
    const originalSize = output.length;

    return `${head}\n…\n${tail}\n\n[Full output saved: ${filePath}] (${originalSize} chars)\n`;
  }

  /**
   * Retrieve the full content for a previously persisted output by its hash.
   * Returns null if the file is not found or cannot be read.
   */
  async retrieve(hash: string): Promise<string | null> {
    const filePath = path.join(this.cacheDir, `${hash}.txt`);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('Unexpected error reading cached output', err as Error, { hash });
      }
      return null;
    }
  }

  /**
   * Remove all cached files older than 24 hours.
   */
  async cleanup(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.cacheDir);
    } catch {
      return;
    }

    const cutoff = Date.now() - CACHE_MAX_AGE_MS;

    for (const file of files) {
      const filePath = path.join(this.cacheDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtime.getTime() < cutoff) {
          await fs.unlink(filePath);
          logger.debug('Removed stale output cache file', { file });
        }
      } catch (err) {
        logger.warn('Could not stat/remove cache file during cleanup', { file, err });
      }
    }
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }
}

export function getOutputPersistenceManager(): OutputPersistenceManager {
  return OutputPersistenceManager.getInstance();
}
