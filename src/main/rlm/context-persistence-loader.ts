import type {
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';
import type { RLMDatabase } from '../persistence/rlm-database';
import type { ContextSectionRow } from '../persistence/rlm-database.types';
import { createSearchIndex, updateSearchIndex } from './context';

const METADATA_ONLY_SECTION_LIMIT = 5_000;
const PERSISTED_SECTION_QUERY_LIMIT = METADATA_ONLY_SECTION_LIMIT + 1;
const METADATA_ONLY_TOKEN_LIMIT = 2_000_000;
const METADATA_ONLY_SIZE_LIMIT = 25 * 1024 * 1024;

export interface PersistedContextState {
  stores: Map<string, ContextStore>;
  sessions: Map<string, RLMSession>;
  loadedStores: number;
  loadedSections: number;
}

export function loadPersistedContextState(db: RLMDatabase): PersistedContextState {
  const stores = new Map<string, ContextStore>();
  const sessions = new Map<string, RLMSession>();
  const storeRows = db.listStores();
  let loadedStores = 0;
  let loadedSections = 0;

  for (const row of storeRows) {
    const queriedSectionRows = db.getSections(row.id, { limit: PERSISTED_SECTION_QUERY_LIMIT });
    const config = parseStoreConfig(row.config_json);
    const metadataOnly = shouldLoadMetadataOnly(row, config, queriedSectionRows.length);
    const sectionRows = queriedSectionRows.slice(0, METADATA_ONLY_SECTION_LIMIT);

    const store: ContextStore = {
      id: row.id,
      instanceId: row.instance_id,
      sections: sectionRows.map((sectionRow) => rowToSection(db, sectionRow, {
        includeContent: !metadataOnly,
      })),
      totalTokens: row.total_tokens,
      totalSize: row.total_size,
      searchIndex: createSearchIndex(),
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      ...(config ? { config } : {}),
    };

    for (const section of store.sections) {
      if (!metadataOnly && section.depth === 0) {
        updateSearchIndex(store.searchIndex!, section);
      }
    }

    stores.set(row.id, store);
    loadedStores += 1;
    loadedSections += sectionRows.length;
  }

  for (const row of db.listSessions()) {
    if (!row.ended_at) {
      sessions.set(row.id, {
        id: row.id,
        storeId: row.store_id,
        instanceId: row.instance_id,
        queries: row.queries_json ? JSON.parse(row.queries_json) : [],
        recursiveCalls: row.recursive_calls_json
          ? JSON.parse(row.recursive_calls_json)
          : [],
        totalRootTokens: row.total_root_tokens,
        totalSubQueryTokens: row.total_sub_query_tokens,
        estimatedDirectTokens: row.estimated_direct_tokens,
        tokenSavingsPercent: row.token_savings_percent,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
      });
    }
  }

  return {
    stores,
    sessions,
    loadedStores,
    loadedSections,
  };
}

function rowToSection(
  db: RLMDatabase,
  row: ContextSectionRow,
  options: { includeContent: boolean },
): ContextSection {
  return {
    id: row.id,
    type: row.type as ContextSection['type'],
    name: row.name,
    content: options.includeContent ? db.getSectionContent(row) : '',
    tokens: row.tokens,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    checksum: row.checksum || '',
    depth: row.depth,
    filePath: row.file_path || undefined,
    language: row.language || undefined,
    sourceUrl: row.source_url || undefined,
    summarizes: row.summarizes_json
      ? JSON.parse(row.summarizes_json)
      : undefined,
    parentSummaryId: row.parent_summary_id || undefined,
  };
}

function shouldLoadMetadataOnly(
  row: { total_tokens: number; total_size: number },
  config: Record<string, unknown> | undefined,
  sectionCount: number,
): boolean {
  if (config?.['kind'] === 'codebase-auto') {
    return true;
  }
  return (
    sectionCount > METADATA_ONLY_SECTION_LIMIT
    || row.total_tokens > METADATA_ONLY_TOKEN_LIMIT
    || row.total_size > METADATA_ONLY_SIZE_LIMIT
  );
}

function parseStoreConfig(configJson: string | null): Record<string, unknown> | undefined {
  if (!configJson) return undefined;
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt store config should not prevent RLM stores from loading.
  }
  return undefined;
}
