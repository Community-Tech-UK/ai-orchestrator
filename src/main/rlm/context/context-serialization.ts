/**
 * Context Serialization Module
 *
 * Handles import/export operations:
 * - Exporting stores to portable format
 * - Importing stores from exported format
 */

import type { ContextStore, ContextSection } from '../../../shared/types/rlm.types';
import type { RLMDatabase } from '../../persistence/rlm-database';
import type { ExportedStore, ImportStoreOptions } from './context.types';
import { generateId } from './context.utils';
import { createSearchIndex } from './context-cache';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ContextSerialization');

/**
 * Dependencies for serialization operations
 */
export interface SerializationDependencies {
  db: RLMDatabase | null;
  persistenceEnabled: boolean;
}

/**
 * Export a store to portable format.
 *
 * @param store - Store to export
 * @returns Exported store data or null if store not found
 */
export function exportStore(store: ContextStore): ExportedStore {
  return {
    version: '1.0',
    exportedAt: Date.now(),
    store: {
      id: store.id,
      instanceId: store.instanceId,
      sections: store.sections.map((s) => ({
        id: s.id,
        type: s.type,
        name: s.name,
        content: s.content,
        tokens: s.tokens,
        startOffset: s.startOffset,
        endOffset: s.endOffset,
        checksum: s.checksum,
        depth: s.depth,
        summarizes: s.summarizes,
        parentSummaryId: s.parentSummaryId,
        filePath: s.filePath,
        language: s.language,
        sourceUrl: s.sourceUrl
      })),
      totalTokens: store.totalTokens,
      totalSize: store.totalSize,
      createdAt: store.createdAt,
      accessCount: store.accessCount
    }
  };
}

/**
 * Import a store from exported format.
 *
 * @param data - Exported store data
 * @param options - Import options
 * @param stores - Map of existing stores
 * @param addSectionFn - Function to add sections (from context-storage)
 * @param deps - Serialization dependencies
 * @returns ID of the imported store
 */
export function importStore(
  data: ExportedStore,
  options: ImportStoreOptions | undefined,
  stores: Map<string, ContextStore>,
  addSectionFn: (
    store: ContextStore,
    type: ContextSection['type'],
    name: string,
    content: string,
    metadata?: Partial<ContextSection>
  ) => ContextSection,
  deps: SerializationDependencies
): string {
  const storeId = options?.newId
    ? generateId('store')
    : options?.targetStoreId || data.store.id;

  if (options?.merge && stores.has(storeId)) {
    // Merge into existing store
    const existing = stores.get(storeId)!;
    for (const section of data.store.sections) {
      const exists = existing.sections.some((s) => s.id === section.id);
      if (!exists) {
        addSectionFn(
          existing,
          section.type,
          section.name,
          section.content,
          {
            filePath: section.filePath,
            language: section.language,
            sourceUrl: section.sourceUrl
          } as Partial<ContextSection>
        );
      }
    }
    return storeId;
  }

  // Create new store
  const instanceId = options?.instanceId || data.store.instanceId;

  const newStore: ContextStore = {
    id: storeId,
    instanceId,
    sections: [],
    totalTokens: 0,
    totalSize: 0,
    searchIndex: createSearchIndex(),
    accessCount: 0,
    createdAt: Date.now(),
    lastAccessed: Date.now()
  };

  stores.set(storeId, newStore);

  // Persist the store
  if (deps.db && deps.persistenceEnabled) {
    try {
      deps.db.createStore({
        id: storeId,
        instanceId
      });
    } catch (error) {
      logger.error('Failed to persist imported store', error instanceof Error ? error : undefined);
    }
  }

  // Add sections
  for (const section of data.store.sections) {
    addSectionFn(
      newStore,
      section.type,
      section.name,
      section.content,
      {
        filePath: section.filePath,
        language: section.language,
        sourceUrl: section.sourceUrl
      } as Partial<ContextSection>
    );
  }

  return storeId;
}
