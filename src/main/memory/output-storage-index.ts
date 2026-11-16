import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { OutputMessage } from '../../shared/types/instance.types';
import type { UserPromptRef } from '../../shared/types/prompt-index.types';

const gunzip = promisify(zlib.gunzip);

export interface StorageMetadata {
  instanceId: string;
  chunkIndex: number;
  messageCount: number;
  startTimestamp: number;
  endTimestamp: number;
  sizeBytes: number;
}

export interface StorageIndex {
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

/**
 * Positions in an index's chunk list whose file still holds that entry's
 * messages. Indices written before chunkIndex stopped being reused after
 * eviction can list the same chunkIndex twice; the file holds only the LAST
 * write, so earlier entries sharing it are unreadable rather than duplicates.
 */
export function readableChunkPositions(chunks: readonly StorageMetadata[]): Set<number> {
  const lastPosition = new Map<number, number>();
  chunks.forEach((chunk, position) => lastPosition.set(chunk.chunkIndex, position));
  return new Set(lastPosition.values());
}

/**
 * Rebuild a lost index from the chunk files it described, oldest first. Each chunk is a complete gzipped message list,
 * so its count, times and size can be read back. Chunks that cannot be read are left out and reported. Returns null for
 * a folder holding no chunk files.
 */
export async function rebuildStorageIndex(
  instanceDir: string,
  instanceId: string,
): Promise<{ index: StorageIndex; unreadableChunks: number } | null> {
  const chunkIndices = (await fs.promises.readdir(instanceDir))
    .map((name) => /^chunk-(\d+)\.gz$/.exec(name))
    .flatMap((match) => (match ? [Number(match[1])] : []))
    .sort((a, b) => a - b);
  if (chunkIndices.length === 0) return null;
  const index: StorageIndex = { instanceId, chunks: [], totalMessages: 0, totalSizeBytes: 0, lastUpdated: 0 };
  let unreadableChunks = 0;
  for (const chunkIndex of chunkIndices) {
    const compressed = await fs.promises.readFile(path.join(instanceDir, `chunk-${chunkIndex.toString().padStart(6, '0')}.gz`));
    let messages: OutputMessage[];
    try {
      messages = JSON.parse((await gunzip(compressed)).toString()) as OutputMessage[];
    } catch {
      unreadableChunks++;
      continue;
    }
    if (!Array.isArray(messages) || messages.length === 0) continue;
    const endTimestamp = messages[messages.length - 1].timestamp;
    index.chunks.push({ instanceId, chunkIndex, messageCount: messages.length, startTimestamp: messages[0].timestamp, endTimestamp, sizeBytes: compressed.length });
    index.totalMessages += messages.length;
    index.totalSizeBytes += compressed.length;
    // Age by the newest message, so the size limit treats recovered leftovers by how old they really are.
    index.lastUpdated = Math.max(index.lastUpdated, endTimestamp);
  }
  return { index, unreadableChunks };
}
