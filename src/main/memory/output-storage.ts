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
import type { InputContextDelivery } from '../../shared/types/input-context-delivery.types';
import { applyInputContextDelivery } from '../../shared/utils/input-context-delivery';
import type { UserPromptRef } from '../../shared/types/prompt-index.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('OutputStorage');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PROMPT_EXCERPT_MAX_LENGTH = 200;
/** How long the most recently decoded chunk stays cached for paging. */
const CHUNK_READ_CACHE_MS = 30_000;

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
  /**
   * Running tally of user prompts stored to disk, in storage order. Absent on
   * indices written before this field existed — getUserPrompts() backfills by
   * scanning the chunks once and persisting the result.
   */
  userPrompts?: UserPromptRef[];
}

/** Squash a prompt to a bounded single line for the index. */
function promptExcerpt(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= PROMPT_EXCERPT_MAX_LENGTH) return text;
  return `${text.slice(0, PROMPT_EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Build the transcript jump-rail's prompt index from every source that can hold
 * a user prompt.
 *
 * Disk storage plus the live buffer is not enough: compaction evicts messages
 * without writing anything to output storage, so a prompt it dropped is in
 * neither and the rail would simply stop listing it. Retained prompts can also
 * arrive under a renumbered id after a hibernate/wake cycle, so they are
 * matched on timestamp rather than id.
 */
export function mergePromptIndex(
  stored: readonly UserPromptRef[],
  outputBuffer: readonly OutputMessage[],
  retainedPrompts: readonly OutputMessage[] | undefined,
): UserPromptRef[] {
  const byId = new Map<string, UserPromptRef>(stored.map((prompt) => [prompt.id, prompt]));
  for (const prompt of toPromptRefs(outputBuffer as OutputMessage[])) {
    byId.set(prompt.id, prompt);
  }

  const seenAt = new Set([...byId.values()].map((prompt) => prompt.timestamp));
  const bufferIdentities = new Set(
    outputBuffer.map((message) => `${message.timestamp}\u0000${message.content}`),
  );
  for (const message of retainedPrompts ?? []) {
    if (bufferIdentities.has(`${message.timestamp}\u0000${message.content}`)) continue;
    const [ref] = toPromptRefs([message]);
    if (!ref || seenAt.has(ref.timestamp)) continue;
    seenAt.add(ref.timestamp);
    byId.set(ref.id, ref);
  }

  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Positions in an index's chunk list whose file still holds that entry's
 * messages. Indices written before chunkIndex stopped being reused after
 * eviction can list the same chunkIndex twice; the file holds only the LAST
 * write, so earlier entries sharing it are unreadable rather than duplicates.
 */
function readableChunkPositions(chunks: readonly StorageMetadata[]): Set<number> {
  const lastPosition = new Map<number, number>();
  chunks.forEach((chunk, position) => lastPosition.set(chunk.chunkIndex, position));
  return new Set(lastPosition.values());
}

/** Map user messages to prompt refs — shared with the prompt-index IPC handler. */
export function toPromptRefs(messages: OutputMessage[]): UserPromptRef[] {
  return messages
    .filter((message) => message.type === 'user')
    .map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      excerpt: promptExcerpt(message.content),
    }));
}

export class OutputStorageManager {
  private storageDir: string;
  private indices: Map<string, StorageIndex> = new Map();
  private pendingWrites = new Map<string, Promise<void>>();
  private chunkReadRevision = 0;
  private pendingEnforcement: Promise<void> = Promise.resolve();
  private maxDiskStorageMB: number = 500;
  private chunkSize: number = 100; // messages per chunk
  private lastReadChunk: { instanceId: string; chunkIndex: number; messages: OutputMessage[] } | null = null;
  /** `${instanceId}/${chunkIndex}` of chunk files found missing — never re-read. */
  private readonly missingChunks = new Set<string>();

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
  storeMessages(instanceId: string, messages: OutputMessage[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve();

    return this.enqueueWrite(instanceId, () => this.writeMessages(instanceId, messages))
      .then(() => this.enforceStorageLimit());
  }

  /** Update existing stored prompts without creating another transcript message. */
  patchInputContextDelivery(instanceId: string, delivery: InputContextDelivery): Promise<void> {
    return this.enqueueWrite(instanceId, () => this.writeInputContextDelivery(instanceId, delivery))
      .then(() => this.enforceStorageLimit());
  }

  private enqueueWrite(instanceId: string, operation: () => Promise<void>): Promise<void> {
    // Output overflows are emitted without awaiting their disk write. Keep each
    // instance ordered so an archive can flush an exact, complete transcript.
    const previousWrite = this.pendingWrites.get(instanceId) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => undefined)
      .then(operation);
    const queued: Promise<void> = write.then(
      () => {
        if (this.pendingWrites.get(instanceId) === queued) {
          this.pendingWrites.delete(instanceId);
        }
      },
      (error: unknown) => {
        if (this.pendingWrites.get(instanceId) === queued) {
          this.pendingWrites.delete(instanceId);
        }
        throw error;
      },
    );
    this.pendingWrites.set(instanceId, queued);
    return queued;
  }

  /** Wait until all previously queued overflow writes for an instance finish. */
  async flushInstance(instanceId: string): Promise<void> {
    await this.pendingWrites.get(instanceId);
  }

  private async writeInputContextDelivery(instanceId: string, delivery: InputContextDelivery): Promise<void> {
    const index = this.indices.get(instanceId);
    if (!index || (index.userPrompts && !index.userPrompts.some(prompt => prompt.id === delivery.messageId))) return;
    const readable = readableChunkPositions(index.chunks);
    for (let position = 0; position < index.chunks.length; position++) {
      if (!readable.has(position)) continue;
      const chunk = index.chunks[position];
      const chunkPath = this.getChunkPath(instanceId, chunk.chunkIndex);
      let original: Buffer;
      try {
        original = await fs.promises.readFile(chunkPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const key = `${instanceId}/${chunk.chunkIndex}`;
        if (!this.missingChunks.has(key)) logger.warn('Stored output chunk is missing', { instanceId, chunkIndex: chunk.chunkIndex });
        this.missingChunks.add(key);
        continue;
      }
      const messages: OutputMessage[] = JSON.parse((await gunzip(original)).toString());
      const updated = applyInputContextDelivery(messages, delivery);
      if (!updated.some((message, offset) => message !== messages[offset])) continue;
      const compressed = await gzip(JSON.stringify(updated));
      const temporaryPath = `${chunkPath}.metadata.tmp`;
      try {
        await fs.promises.writeFile(temporaryPath, compressed);
        await fs.promises.rename(temporaryPath, chunkPath);
      } finally {
        await fs.promises.rm(temporaryPath, { force: true });
      }
      this.chunkReadRevision++;
      this.lastReadChunk = null;
      index.totalSizeBytes += compressed.length - chunk.sizeBytes;
      chunk.sizeBytes = compressed.length;
      index.lastUpdated = Date.now();
      await this.saveIndex(instanceId, index);
    }
  }

  private async writeMessages(instanceId: string, messages: OutputMessage[]): Promise<void> {
    const index = this.getOrCreateIndex(instanceId);
    // Chunk files are named by chunkIndex, which eviction does not renumber.
    // Deriving it from chunks.length after an eviction reused the newest
    // chunk's name and overwrote its file.
    const newestChunk = index.chunks[index.chunks.length - 1];
    const chunkIndex = newestChunk ? newestChunk.chunkIndex + 1 : 0;

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
    // Only append when the tally exists: a legacy index (written before the
    // field existed) stays undefined so getUserPrompts() backfills the FULL
    // history by chunk scan — appending here first would look complete and
    // silently drop every pre-existing prompt.
    if (index.userPrompts) {
      index.userPrompts.push(...toPromptRefs(messages));
    }

    await this.saveIndex(instanceId, index);
  }

  /**
   * Load messages from disk for an instance. `startChunk`/`endChunk` are
   * positions in the index's chunk list.
   */
  async loadMessages(
    instanceId: string,
    options?: {
      startChunk?: number;
      endChunk?: number;
      limit?: number;
    }
  ): Promise<OutputMessage[]> {
    await this.flushInstance(instanceId);
    const index = this.indices.get(instanceId);
    if (!index || index.chunks.length === 0) {
      return [];
    }

    const startChunk = options?.startChunk ?? 0;
    const endChunk = options?.endChunk ?? index.chunks.length - 1;
    const limit = options?.limit;
    const readable = readableChunkPositions(index.chunks);

    const allMessages: OutputMessage[] = [];

    for (let i = startChunk; i <= endChunk && i < index.chunks.length; i++) {
      if (!readable.has(i)) continue;
      allMessages.push(...(await this.readChunk(instanceId, index.chunks[i].chunkIndex)));

      if (limit && allMessages.length >= limit) {
        return allMessages.slice(0, limit);
      }
    }

    return limit ? allMessages.slice(0, limit) : allMessages;
  }

  /**
   * Page backwards through stored history by message offset: returns up to
   * `limit` messages ending just before `beforeOffset` (default: the end of
   * storage), oldest first, plus the offset of the first one returned. Pass
   * that `startOffset` back as the next `beforeOffset`; 0 means the start of
   * the session has been reached.
   *
   * Chunk sizes vary wildly — buffer-overflow trimming writes one message per
   * chunk while a history restore writes thousands in one — so paging by
   * chunk count returned three messages at a time in one session and silently
   * dropped most of a large chunk in another.
   */
  async loadMessagesBefore(
    instanceId: string,
    options: { beforeOffset?: number; limit: number },
  ): Promise<{ messages: OutputMessage[]; startOffset: number; totalStored: number }> {
    await this.flushInstance(instanceId);
    const index = this.indices.get(instanceId);
    if (!index || index.chunks.length === 0) {
      return { messages: [], startOffset: 0, totalStored: 0 };
    }

    const totalStored = index.chunks.reduce((sum, chunk) => sum + chunk.messageCount, 0);
    const endOffset = Math.min(Math.max(0, options.beforeOffset ?? totalStored), totalStored);
    const startOffset = Math.max(0, endOffset - Math.max(1, options.limit));
    const readable = readableChunkPositions(index.chunks);

    const messages: OutputMessage[] = [];
    let chunkStart = 0;
    for (let i = 0; i < index.chunks.length && chunkStart < endOffset; i++) {
      const chunk = index.chunks[i];
      const chunkEnd = chunkStart + chunk.messageCount;
      if (chunkEnd > startOffset && readable.has(i)) {
        const chunkMessages = await this.readChunk(instanceId, chunk.chunkIndex, true);
        messages.push(
          ...chunkMessages.slice(
            Math.max(0, startOffset - chunkStart),
            Math.min(chunk.messageCount, endOffset - chunkStart),
          ),
        );
      }
      chunkStart = chunkEnd;
    }

    return { messages, startOffset, totalStored };
  }

  /**
   * Read one chunk file; [] (logged) when it is missing or unreadable.
   * `useCache` shares decoded message objects between calls, so only callers
   * that never mutate them (the IPC pager, whose results are cloned) opt in.
   */
  private async readChunk(instanceId: string, chunkIndex: number, useCache = false): Promise<OutputMessage[]> {
    const readRevision = this.chunkReadRevision;
    const cached = this.lastReadChunk;
    if (useCache && cached && cached.instanceId === instanceId && cached.chunkIndex === chunkIndex) {
      return cached.messages;
    }
    const chunkKey = `${instanceId}/${chunkIndex}`;
    if (this.missingChunks.has(chunkKey)) return [];
    try {
      const compressed = await fs.promises.readFile(this.getChunkPath(instanceId, chunkIndex));
      const messages: OutputMessage[] = JSON.parse((await gunzip(compressed)).toString());
      if (!useCache || readRevision !== this.chunkReadRevision) return messages;
      // Paging walks a large restored chunk one page at a time; keep the last
      // decoded chunk briefly so each page does not gunzip it again. Chunk
      // metadata rewrites invalidate it; an older in-flight read cannot restore stale data.
      const entry = { instanceId, chunkIndex, messages };
      this.lastReadChunk = entry;
      setTimeout(() => {
        if (this.lastReadChunk === entry) this.lastReadChunk = null;
      }, CHUNK_READ_CACHE_MS).unref?.();
      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Some legacy indices list thousands of chunks whose files are gone;
        // report each once instead of on every page that spans it.
        this.missingChunks.add(chunkKey);
        logger.warn('Stored output chunk is missing', { chunkIndex, instanceId });
      } else {
        logger.error('Failed to load chunk', error instanceof Error ? error : undefined, { chunkIndex, instanceId });
      }
      return [];
    }
  }

  /**
   * All user prompts stored to disk for an instance, in storage order.
   *
   * Indices written before the userPrompts field existed are backfilled by
   * scanning every chunk once; the result is persisted so the scan never
   * repeats. Returns [] for unknown instances.
   */
  async getUserPrompts(instanceId: string): Promise<UserPromptRef[]> {
    let prompts: UserPromptRef[] = [];
    await this.enqueueWrite(instanceId, async () => {
      const index = this.indices.get(instanceId);
      if (!index) return;
      if (index.userPrompts) { prompts = index.userPrompts; return; }
      // Backfilling also commits the index: own the same queue as deletion.
      const messages: OutputMessage[] = [];
      const readable = readableChunkPositions(index.chunks);
      for (let position = 0; position < index.chunks.length; position++) {
        if (readable.has(position)) messages.push(...await this.readChunk(instanceId, index.chunks[position].chunkIndex));
      }
      prompts = index.userPrompts = toPromptRefs(messages);
      try {
        await this.saveIndex(instanceId, index);
      } catch (error) {
        logger.warn('Failed to persist backfilled prompt index', { instanceId, error: String(error) });
      }
    });
    return prompts;
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
  deleteInstance(instanceId: string): Promise<void> {
    return this.enqueueWrite(instanceId, () => this.deleteStoredInstance(instanceId));
  }

  private async deleteStoredInstance(instanceId: string): Promise<void> {
    const index = this.indices.get(instanceId);
    if (!index) return;

    this.chunkReadRevision++;
    if (this.lastReadChunk?.instanceId === instanceId) this.lastReadChunk = null;
    for (const key of this.missingChunks) {
      if (key.startsWith(`${instanceId}/`)) this.missingChunks.delete(key);
    }

    // Delete all chunk files
    for (const chunk of index.chunks) {
      const chunkPath = this.getChunkPath(instanceId, chunk.chunkIndex);
      try {
        await fs.promises.unlink(chunkPath);
      } catch {
        // Ignore if file doesn't exist
      }
    }

    // Delete index file
    const indexPath = this.getIndexPath(instanceId);
    try {
      await fs.promises.unlink(indexPath);
    } catch {
      // Ignore if file doesn't exist
    }

    // Delete instance directory if empty
    const instanceDir = path.join(this.storageDir, instanceId);
    try {
      await fs.promises.rmdir(instanceDir);
    } catch {
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
        userPrompts: [],
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
  private enforceStorageLimit(): Promise<void> {
    // No instance-owned operation awaits this queue: a pass acquires each
    // target's ordinary write queue only after the initiating write released it.
    const pass = this.pendingEnforcement.catch(() => undefined)
      .then(() => this.enforceStorageLimitPass());
    this.pendingEnforcement = pass;
    return pass;
  }

  private async enforceStorageLimitPass(): Promise<void> {
    if (this.maxDiskStorageMB === 0) return; // Unlimited
    const maxBytes = this.maxDiskStorageMB * 1024 * 1024;
    const totalBytes = () => [...this.indices.values()].reduce((sum, index) => sum + index.totalSizeBytes, 0);
    const sortedIndices = [...this.indices.values()].sort((a, b) => a.lastUpdated - b.lastUpdated);
    for (const index of sortedIndices) {
      if (totalBytes() <= maxBytes) break;
      await this.enqueueWrite(index.instanceId, async () => {
        // A queued explicit delete and subsequent store may have replaced it.
        if (this.indices.get(index.instanceId) !== index) return;
        while (totalBytes() > maxBytes && index.chunks.length > 0) {
          const oldestChunk = index.chunks[0];
          const sharedFile = index.chunks.some(
            (chunk, position) => position > 0 && chunk.chunkIndex === oldestChunk.chunkIndex,
          );
          if (!sharedFile) {
            try {
              await fs.promises.unlink(this.getChunkPath(index.instanceId, oldestChunk.chunkIndex));
            } catch {
              // Ignore if file doesn't exist, as with ordinary instance deletion.
            }
          }
          this.chunkReadRevision++;
          this.lastReadChunk = null;
          index.totalSizeBytes -= oldestChunk.sizeBytes;
          index.totalMessages -= oldestChunk.messageCount;
          index.chunks.shift();
          if (index.userPrompts?.length) {
            index.userPrompts = index.userPrompts.filter(prompt => prompt.timestamp > oldestChunk.endTimestamp);
          }
          if (index.chunks.length === 0) {
            // Already owns this instance queue: do not enqueue public deletion.
            await this.deleteStoredInstance(index.instanceId);
            break;
          }
          await this.saveIndex(index.instanceId, index);
        }
      });
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

export function _resetOutputStorageManagerForTesting(): void {
  outputStorageManager = null;
}
