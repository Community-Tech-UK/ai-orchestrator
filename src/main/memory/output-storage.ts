/**
 * Output Storage Manager - Disk-based storage for instance output
 *
 * Saves older output messages to disk to reduce memory usage while
 * maintaining access to full conversation history.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('OutputStorage');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

interface StorageMetadata {
  instanceId: string;
  chunkIndex: number;
  messageCount: number;
  startTimestamp: number;
  endTimestamp: number;
  sizeBytes: number;
}

interface StorageIndex {
  instanceId: string;
  chunks: StorageMetadata[];
  totalMessages: number;
  totalSizeBytes: number;
  lastUpdated: number;
}

export class OutputStorageManager {
  private storageDir: string;
  private indices: Map<string, StorageIndex> = new Map();
  private maxDiskStorageMB: number = 500;
  private chunkSize: number = 100; // messages per chunk

  constructor() {
    this.storageDir = path.join(app.getPath('userData'), 'output-storage');
    this.ensureStorageDir();
    this.loadIndices();
  }

  /**
   * Configure storage limits
   */
  configure(options: { maxDiskStorageMB?: number; chunkSize?: number }): void {
    if (options.maxDiskStorageMB !== undefined) {
      this.maxDiskStorageMB = options.maxDiskStorageMB;
    }
    if (options.chunkSize !== undefined) {
      this.chunkSize = options.chunkSize;
    }
  }

  /**
   * Store messages to disk for an instance
   */
  async storeMessages(instanceId: string, messages: OutputMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const index = this.getOrCreateIndex(instanceId);
    const chunkIndex = index.chunks.length;

    // Compress and write the messages
    const data = JSON.stringify(messages);
    const compressed = await gzip(data);

    const chunkPath = this.getChunkPath(instanceId, chunkIndex);
    await fs.promises.writeFile(chunkPath, compressed);

    // Update index
    const metadata: StorageMetadata = {
      instanceId,
      chunkIndex,
      messageCount: messages.length,
      startTimestamp: messages[0].timestamp,
      endTimestamp: messages[messages.length - 1].timestamp,
      sizeBytes: compressed.length,
    };

    index.chunks.push(metadata);
    index.totalMessages += messages.length;
    index.totalSizeBytes += compressed.length;
    index.lastUpdated = Date.now();

    await this.saveIndex(instanceId, index);

    // Check if we need to clean up old data
    await this.enforceStorageLimit();
  }

  /**
   * Load messages from disk for an instance
   */
  async loadMessages(
    instanceId: string,
    options?: {
      startChunk?: number;
      endChunk?: number;
      limit?: number;
    }
  ): Promise<OutputMessage[]> {
    const index = this.indices.get(instanceId);
    if (!index || index.chunks.length === 0) {
      return [];
    }

    const startChunk = options?.startChunk ?? 0;
    const endChunk = options?.endChunk ?? index.chunks.length - 1;
    const limit = options?.limit;

    const allMessages: OutputMessage[] = [];

    for (let i = startChunk; i <= endChunk && i < index.chunks.length; i++) {
      const chunkPath = this.getChunkPath(instanceId, i);

      try {
        const compressed = await fs.promises.readFile(chunkPath);
        const data = await gunzip(compressed);
        const messages: OutputMessage[] = JSON.parse(data.toString());
        allMessages.push(...messages);

        if (limit && allMessages.length >= limit) {
          return allMessages.slice(0, limit);
        }
      } catch (error) {
        logger.error('Failed to load chunk', error instanceof Error ? error : undefined, { chunkIndex: i, instanceId });
      }
    }

    return limit ? allMessages.slice(0, limit) : allMessages;
  }

  /**
   * Get storage statistics for an instance
   */
  getInstanceStats(instanceId: string): {
    totalMessages: number;
    totalSizeBytes: number;
    chunkCount: number;
  } | null {
    const index = this.indices.get(instanceId);
    if (!index) return null;

    return {
      totalMessages: index.totalMessages,
      totalSizeBytes: index.totalSizeBytes,
      chunkCount: index.chunks.length,
    };
  }

  /**
   * Get total storage statistics
   */
  getTotalStats(): {
    totalInstances: number;
    totalMessages: number;
    totalSizeMB: number;
    maxSizeMB: number;
  } {
    let totalMessages = 0;
    let totalSizeBytes = 0;

    for (const index of this.indices.values()) {
      totalMessages += index.totalMessages;
      totalSizeBytes += index.totalSizeBytes;
    }

    return {
      totalInstances: this.indices.size,
      totalMessages,
      totalSizeMB: Math.round(totalSizeBytes / (1024 * 1024) * 100) / 100,
      maxSizeMB: this.maxDiskStorageMB,
    };
  }

  /**
   * Delete all stored output for an instance
   */
  async deleteInstance(instanceId: string): Promise<void> {
    const index = this.indices.get(instanceId);
    if (!index) return;

    // Delete all chunk files
    for (let i = 0; i < index.chunks.length; i++) {
      const chunkPath = this.getChunkPath(instanceId, i);
      try {
        await fs.promises.unlink(chunkPath);
      } catch (error) {
        // Ignore if file doesn't exist
      }
    }

    // Delete index file
    const indexPath = this.getIndexPath(instanceId);
    try {
      await fs.promises.unlink(indexPath);
    } catch (error) {
      // Ignore if file doesn't exist
    }

    // Delete instance directory if empty
    const instanceDir = path.join(this.storageDir, instanceId);
    try {
      await fs.promises.rmdir(instanceDir);
    } catch (error) {
      // Ignore if not empty or doesn't exist
    }

    this.indices.delete(instanceId);
  }

  /**
   * Clean up storage for instances that no longer exist
   */
  async cleanupOrphanedStorage(activeInstanceIds: string[]): Promise<void> {
    const activeSet = new Set(activeInstanceIds);

    for (const instanceId of this.indices.keys()) {
      if (!activeSet.has(instanceId)) {
        await this.deleteInstance(instanceId);
      }
    }
  }

  /**
   * Ensure storage directory exists
   */
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Load all indices from disk
   */
  private loadIndices(): void {
    try {
      const dirs = fs.readdirSync(this.storageDir);

      for (const dir of dirs) {
        const indexPath = path.join(this.storageDir, dir, 'index.json');
        if (fs.existsSync(indexPath)) {
          try {
            const data = fs.readFileSync(indexPath, 'utf-8');
            const index: StorageIndex = JSON.parse(data);
            this.indices.set(dir, index);
          } catch (error) {
            logger.error('Failed to load index', error instanceof Error ? error : undefined, { dir });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load storage indices', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Get or create index for an instance
   */
  private getOrCreateIndex(instanceId: string): StorageIndex {
    let index = this.indices.get(instanceId);
    if (!index) {
      index = {
        instanceId,
        chunks: [],
        totalMessages: 0,
        totalSizeBytes: 0,
        lastUpdated: Date.now(),
      };
      this.indices.set(instanceId, index);

      // Ensure instance directory exists
      const instanceDir = path.join(this.storageDir, instanceId);
      if (!fs.existsSync(instanceDir)) {
        fs.mkdirSync(instanceDir, { recursive: true });
      }
    }
    return index;
  }

  /**
   * Save index to disk
   */
  private async saveIndex(instanceId: string, index: StorageIndex): Promise<void> {
    const indexPath = this.getIndexPath(instanceId);
    await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * Get path for a chunk file
   */
  private getChunkPath(instanceId: string, chunkIndex: number): string {
    return path.join(this.storageDir, instanceId, `chunk-${chunkIndex.toString().padStart(6, '0')}.gz`);
  }

  /**
   * Get path for index file
   */
  private getIndexPath(instanceId: string): string {
    return path.join(this.storageDir, instanceId, 'index.json');
  }

  /**
   * Enforce storage limit by removing oldest data
   */
  private async enforceStorageLimit(): Promise<void> {
    if (this.maxDiskStorageMB === 0) return; // Unlimited

    const maxBytes = this.maxDiskStorageMB * 1024 * 1024;
    let totalBytes = 0;

    for (const index of this.indices.values()) {
      totalBytes += index.totalSizeBytes;
    }

    if (totalBytes <= maxBytes) return;

    // Sort indices by last updated (oldest first)
    const sortedIndices = Array.from(this.indices.values())
      .sort((a, b) => a.lastUpdated - b.lastUpdated);

    // Remove oldest chunks until we're under the limit
    for (const index of sortedIndices) {
      while (totalBytes > maxBytes && index.chunks.length > 0) {
        const oldestChunk = index.chunks[0];

        // Delete the chunk file
        const chunkPath = this.getChunkPath(index.instanceId, oldestChunk.chunkIndex);
        try {
          await fs.promises.unlink(chunkPath);
        } catch (error) {
          // Ignore if file doesn't exist
        }

        // Update totals
        totalBytes -= oldestChunk.sizeBytes;
        index.totalSizeBytes -= oldestChunk.sizeBytes;
        index.totalMessages -= oldestChunk.messageCount;
        index.chunks.shift();

        // If instance has no more chunks, delete it entirely
        if (index.chunks.length === 0) {
          await this.deleteInstance(index.instanceId);
          break;
        } else {
          await this.saveIndex(index.instanceId, index);
        }
      }

      if (totalBytes <= maxBytes) break;
    }
  }

  /**
   * Get storage directory path
   */
  getStoragePath(): string {
    return this.storageDir;
  }
}

// Singleton instance
let outputStorageManager: OutputStorageManager | null = null;

export function getOutputStorageManager(): OutputStorageManager {
  if (!outputStorageManager) {
    outputStorageManager = new OutputStorageManager();
  }
  return outputStorageManager;
}
