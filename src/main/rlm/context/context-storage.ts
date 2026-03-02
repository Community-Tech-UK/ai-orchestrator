/**
 * Context Storage Module
 *
 * Handles store and section CRUD operations:
 * - Creating stores
 * - Adding sections (single and batch)
 * - Removing sections
 * - Deleting stores
 */

import type {
  ContextStore,
  ContextSection,
  SummaryLevel
} from '../../../shared/types/rlm.types';
import type { RLMDatabase } from '../../persistence/rlm-database';
import type { VectorStore } from '../vector-store';
import type { SectionInput } from './context.types';
import {
  estimateTokens,
  computeChecksum,
  generateId,
  generateShortId,
  splitContent
} from './context.utils';
import { updateSearchIndex, createSearchIndex } from './context-cache';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ContextStorage');

/**
 * Dependencies for storage operations
 */
export interface StorageDependencies {
  db: RLMDatabase | null;
  vectorStore: VectorStore | null;
  persistenceEnabled: boolean;
  maxSectionTokens: number;
  summaryThreshold: number;
  tokenEstimator?: (text: string) => number;
}

/**
 * Create a new context store.
 *
 * @param instanceId - Instance ID to associate with the store
 * @param stores - Map of existing stores (for duplicate check)
 * @param deps - Storage dependencies
 * @returns New or existing ContextStore
 */
export function createStore(
  instanceId: string,
  stores: Map<string, ContextStore>,
  deps: StorageDependencies
): ContextStore {
  // Check if store already exists for this instance
  const existing = Array.from(stores.values()).find(
    (s) => s.instanceId === instanceId
  );
  if (existing) {
    return existing;
  }

  const store: ContextStore = {
    id: generateId('ctx'),
    instanceId,
    sections: [],
    totalTokens: 0,
    totalSize: 0,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 0
  };

  // Persist to database
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.createStore({
        id: store.id,
        instanceId: store.instanceId
      });
    } catch (error) {
      logger.error('Failed to persist store', error instanceof Error ? error : undefined);
    }
  }

  stores.set(store.id, store);
  return store;
}

/**
 * Add a section to a store.
 * Handles large sections by splitting them automatically.
 *
 * @param store - Store to add section to
 * @param type - Section type
 * @param name - Section name
 * @param content - Section content
 * @param metadata - Optional additional metadata
 * @param deps - Storage dependencies
 * @returns Created ContextSection
 */
export function addSection(
  store: ContextStore,
  type: ContextSection['type'],
  name: string,
  content: string,
  metadata: Partial<ContextSection> | undefined,
  deps: StorageDependencies
): ContextSection {
  const tokenEstimator = deps.tokenEstimator || estimateTokens;
  const tokens = tokenEstimator(content);

  // Check if we need to split large sections
  if (tokens > deps.maxSectionTokens) {
    return addLargeSection(store, type, name, content, metadata, deps);
  }

  const section: ContextSection = {
    id: generateId('sec'),
    type,
    name,
    content,
    tokens,
    startOffset: store.totalSize,
    endOffset: store.totalSize + content.length,
    checksum: computeChecksum(content),
    depth: 0,
    ...metadata
  };

  store.sections.push(section);
  store.totalTokens += tokens;
  store.totalSize += content.length;

  // Persist section to database
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.addSection({
        id: section.id,
        storeId: store.id,
        type: section.type,
        name: section.name,
        startOffset: section.startOffset,
        endOffset: section.endOffset,
        tokens: section.tokens,
        checksum: section.checksum,
        depth: section.depth,
        summarizes: section.summarizes,
        parentSummaryId: section.parentSummaryId,
        filePath: section.filePath,
        language: section.language,
        sourceUrl: section.sourceUrl,
        content: section.content
      });
      // Also index the section for search
      deps.db.indexSection(store.id, section.id, section.content);
    } catch (error) {
      logger.error('Failed to persist section', error instanceof Error ? error : undefined);
    }
  }

  // Rebuild search index incrementally
  if (!store.searchIndex) {
    store.searchIndex = createSearchIndex();
  }
  updateSearchIndex(store.searchIndex!, section);

  // Add vector for semantic search (async, don't await)
  if (deps.vectorStore) {
    deps.vectorStore
      .addSection(store.id, section.id, section.content, {
        type: section.type,
        name: section.name,
        filePath: section.filePath,
        language: section.language
      })
      .catch((error: unknown) => {
        logger.error('Failed to add vector for section', error instanceof Error ? error : undefined);
      });
  }

  // Check if summarization needed
  if (store.totalTokens > deps.summaryThreshold) {
    prepareSummaryLevel(store, deps.maxSectionTokens);
  }

  return section;
}

/**
 * Add a large section by splitting it into chunks.
 */
function addLargeSection(
  store: ContextStore,
  type: ContextSection['type'],
  name: string,
  content: string,
  metadata: Partial<ContextSection> | undefined,
  deps: StorageDependencies
): ContextSection {
  const tokenEstimator = deps.tokenEstimator || estimateTokens;
  const chunks = splitContent(content, deps.maxSectionTokens, tokenEstimator);
  const sections: ContextSection[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkSection: ContextSection = {
      id: generateShortId('sec', i),
      type,
      name: `${name} (part ${i + 1}/${chunks.length})`,
      content: chunks[i],
      tokens: tokenEstimator(chunks[i]),
      startOffset: store.totalSize,
      endOffset: store.totalSize + chunks[i].length,
      checksum: computeChecksum(chunks[i]),
      depth: 0,
      ...metadata
    };

    store.sections.push(chunkSection);
    store.totalTokens += chunkSection.tokens;
    store.totalSize += chunks[i].length;

    // Persist each chunk to database
    if (deps.db && deps.persistenceEnabled) {
      try {
        deps.db.addSection({
          id: chunkSection.id,
          storeId: store.id,
          type: chunkSection.type,
          name: chunkSection.name,
          startOffset: chunkSection.startOffset,
          endOffset: chunkSection.endOffset,
          tokens: chunkSection.tokens,
          checksum: chunkSection.checksum,
          depth: chunkSection.depth,
          filePath: chunkSection.filePath,
          language: chunkSection.language,
          sourceUrl: chunkSection.sourceUrl,
          content: chunkSection.content
        });
        deps.db.indexSection(store.id, chunkSection.id, chunkSection.content);
      } catch (error) {
        logger.error('Failed to persist chunk section', error instanceof Error ? error : undefined);
      }
    }

    // Add vector for semantic search (async, don't await)
    if (deps.vectorStore) {
      deps.vectorStore
        .addSection(store.id, chunkSection.id, chunkSection.content, {
          type: chunkSection.type,
          name: chunkSection.name,
          filePath: chunkSection.filePath,
          language: chunkSection.language
        })
        .catch((error: unknown) => {
          logger.error('Failed to add vector for chunk section', error instanceof Error ? error : undefined);
        });
    }

    if (!store.searchIndex) {
      store.searchIndex = createSearchIndex();
    }
    updateSearchIndex(store.searchIndex!, chunkSection);
    sections.push(chunkSection);
  }

  // Return first section as reference
  return sections[0];
}

/**
 * Batch add multiple sections with deferred index rebuild.
 * Much faster than adding sections one by one.
 *
 * @param store - Store to add sections to
 * @param sections - Array of section inputs
 * @param deps - Storage dependencies
 * @returns Array of created section IDs
 */
export async function addSectionsBatch(
  store: ContextStore,
  sections: SectionInput[],
  deps: StorageDependencies
): Promise<string[]> {
  const tokenEstimator = deps.tokenEstimator || estimateTokens;
  const ids: string[] = [];
  const addedSections: ContextSection[] = [];

  // Process all sections without rebuilding index each time
  for (const input of sections) {
    const tokens = tokenEstimator(input.content);
    const section: ContextSection = {
      id: generateId('sec'),
      type: input.type,
      name: input.name,
      content: input.content,
      tokens,
      startOffset: store.totalSize,
      endOffset: store.totalSize + input.content.length,
      checksum: computeChecksum(input.content),
      depth: 0,
      ...input.metadata
    };

    store.sections.push(section);
    store.totalTokens += tokens;
    store.totalSize += input.content.length;
    ids.push(section.id);
    addedSections.push(section);

    // Persist section to database
    if (deps.db && deps.persistenceEnabled) {
      try {
        deps.db.addSection({
          id: section.id,
          storeId: store.id,
          type: section.type,
          name: section.name,
          startOffset: section.startOffset,
          endOffset: section.endOffset,
          tokens: section.tokens,
          checksum: section.checksum,
          depth: section.depth,
          filePath: section.filePath,
          language: section.language,
          sourceUrl: section.sourceUrl,
          content: section.content
        });
      } catch (error) {
        logger.error('Failed to persist batch section', error instanceof Error ? error : undefined);
      }
    }
  }

  // Initialize search index if needed
  if (!store.searchIndex) {
    store.searchIndex = createSearchIndex();
  }

  // Rebuild search index once for all sections
  for (const section of addedSections) {
    updateSearchIndex(store.searchIndex!, section);
  }

  // Batch index sections in database
  if (deps.db && deps.persistenceEnabled) {
    for (const section of addedSections) {
      try {
        deps.db.indexSection(store.id, section.id, section.content);
      } catch (error) {
        logger.error('Failed to index batch section', error instanceof Error ? error : undefined);
      }
    }
  }

  // Batch generate embeddings for semantic search
  if (deps.vectorStore) {
    try {
      await deps.vectorStore.indexStore(
        store.id,
        addedSections.map((s) => ({ id: s.id, content: s.content }))
      );
    } catch (error) {
      logger.error('Failed to batch index vectors', error instanceof Error ? error : undefined);
    }
  }

  return ids;
}

/**
 * Remove a section from a store.
 *
 * @param store - Store to remove section from
 * @param sectionId - ID of section to remove
 * @param deps - Storage dependencies
 * @returns Removed section or null if not found
 */
export function removeSection(
  store: ContextStore,
  sectionId: string,
  deps: StorageDependencies
): ContextSection | null {
  const index = store.sections.findIndex((s) => s.id === sectionId);
  if (index === -1) return null;

  const section = store.sections[index];

  // Remove from database
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.removeSection(sectionId);
    } catch (error) {
      logger.error('Failed to remove section from database', error instanceof Error ? error : undefined);
    }
  }

  // Remove from vector store
  if (deps.vectorStore) {
    try {
      deps.vectorStore.removeSection(sectionId);
    } catch (error) {
      logger.error('Failed to remove section from vector store', error instanceof Error ? error : undefined);
    }
  }

  store.sections.splice(index, 1);
  store.totalTokens -= section.tokens;

  return section;
}

/**
 * Delete a store and all its sections.
 *
 * @param storeId - ID of store to delete
 * @param stores - Map of stores
 * @param sessions - Map of sessions (to clean up related sessions)
 * @param deps - Storage dependencies
 */
export function deleteStore(
  storeId: string,
  stores: Map<string, ContextStore>,
  sessions: Map<string, { storeId: string }>,
  deps: StorageDependencies
): void {
  // Delete from database first (cascades to sections, search index, sessions)
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.deleteStore(storeId);
    } catch (error) {
      logger.error('Failed to delete store from database', error instanceof Error ? error : undefined);
    }
  }

  // Clear vectors for this store
  if (deps.vectorStore) {
    try {
      deps.vectorStore.clearStore(storeId);
    } catch (error) {
      logger.error('Failed to clear vectors for store', error instanceof Error ? error : undefined);
    }
  }

  stores.delete(storeId);

  // Also clean up related sessions from memory
  for (const [sessionId, session] of sessions) {
    if (session.storeId === storeId) {
      sessions.delete(sessionId);
    }
  }
}

/**
 * Persist a summary as a new section in the store.
 *
 * @param store - Store to add summary to
 * @param summaryContent - Summary content
 * @param summarizedSectionIds - IDs of sections being summarized
 * @param summarizedSections - The actual sections being summarized
 * @param deps - Storage dependencies
 * @returns Created summary section or null on error
 */
export function persistSummary(
  store: ContextStore,
  summaryContent: string,
  summarizedSectionIds: string[],
  summarizedSections: ContextSection[],
  deps: StorageDependencies
): ContextSection | null {
  try {
    const tokenEstimator = deps.tokenEstimator || estimateTokens;
    const summaryTokens = tokenEstimator(summaryContent);

    const summaryDepth = Math.max(
      1,
      ...summarizedSections.map((s) => s.depth + 1)
    );
    const summarySection: ContextSection = {
      id: generateId('sum'),
      type: 'summary',
      name: `Summary of ${summarizedSections.length} sections`,
      content: summaryContent,
      tokens: summaryTokens,
      startOffset: store.totalSize,
      endOffset: store.totalSize + summaryContent.length,
      checksum: computeChecksum(summaryContent),
      depth: summaryDepth,
      summarizes: summarizedSectionIds
    };

    store.sections.push(summarySection);
    store.totalTokens += summaryTokens;
    store.totalSize += summaryContent.length;

    // Persist to database
    if (deps.db && deps.persistenceEnabled) {
      deps.db.addSection({
        id: summarySection.id,
        storeId: store.id,
        type: summarySection.type,
        name: summarySection.name,
        startOffset: summarySection.startOffset,
        endOffset: summarySection.endOffset,
        tokens: summarySection.tokens,
        checksum: summarySection.checksum,
        depth: summarySection.depth,
        summarizes: summarySection.summarizes,
        content: summarySection.content
      });
    }

    // Update summary index
    if (!store.summaryIndex) {
      store.summaryIndex = { levels: [], sectionToSummary: new Map() };
    }
    for (const sectionId of summarizedSectionIds) {
      store.summaryIndex.sectionToSummary.set(sectionId, summarySection.id);
    }

    return summarySection;
  } catch (error) {
    logger.error('Failed to persist summary', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Prepare summary level placeholders for large stores.
 * Groups original sections for potential summarization.
 *
 * @param store - Store to prepare summaries for
 * @param maxSectionTokens - Maximum tokens per section
 */
export function prepareSummaryLevel(
  store: ContextStore,
  maxSectionTokens: number
): void {
  // Initialize summary index if needed
  if (!store.summaryIndex) {
    store.summaryIndex = {
      levels: [],
      sectionToSummary: new Map()
    };
  }

  // Group original sections for potential summarization
  const originalSections = store.sections.filter((s) => s.depth === 0);
  const groupSize = 10;

  for (let i = 0; i < originalSections.length; i += groupSize) {
    const group = originalSections.slice(i, i + groupSize);
    const groupTokens = group.reduce((sum, s) => sum + s.tokens, 0);

    // Only create placeholder if group is large enough
    if (groupTokens > maxSectionTokens * 2) {
      const placeholder: ContextSection = {
        id: `summary-placeholder-${Date.now()}-${i}`,
        type: 'summary',
        name: `Summary: ${group[0].name} - ${group[group.length - 1].name}`,
        content: `[Pending summary of ${group.length} sections, ~${groupTokens} tokens]`,
        tokens: 100, // Placeholder estimate
        startOffset: 0,
        endOffset: 0,
        checksum: '',
        summarizes: group.map((s) => s.id),
        depth: 1
      };

      // Track in summary index
      const level: SummaryLevel = {
        depth: 1,
        sections: [placeholder],
        totalTokens: 100,
        compressionRatio: groupTokens / 100
      };
      store.summaryIndex.levels.push(level);

      for (const s of group) {
        store.summaryIndex.sectionToSummary.set(s.id, placeholder.id);
      }
    }
  }
}
