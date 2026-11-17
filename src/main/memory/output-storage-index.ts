import type { UserPromptRef } from '../../shared/types/prompt-index.types';

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
