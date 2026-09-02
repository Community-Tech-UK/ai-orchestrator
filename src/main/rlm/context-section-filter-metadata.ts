import type { ContextSection, ContextStore } from '../../shared/types/rlm.types';
import type { RLMDatabase } from '../persistence/rlm-database';

export interface ContextSectionFilterMetadata {
  type: ContextSection['type'];
  filePath?: string;
}

export interface ContextSectionFilterMetadataPage {
  sections: ContextSectionFilterMetadata[];
  nextOffset?: number;
}

export function listSectionFilterMetadataPage(
  store: ContextStore | undefined,
  db: RLMDatabase | null,
  persistenceEnabled: boolean,
  offset: number,
  limit: number,
): ContextSectionFilterMetadataPage {
  if (!store) return { sections: [] };
  const rows = persistenceEnabled && db
    ? db.getSectionFilterMetadata(store.id, { offset, limit: limit + 1 }).map((row) => ({
      type: row.type as ContextSection['type'],
      ...(row.file_path === null ? {} : { filePath: row.file_path }),
    }))
    : store.sections.slice(offset, offset + limit + 1).map((section) => ({
      type: section.type,
      ...(section.filePath === undefined ? {} : { filePath: section.filePath }),
    }));
  const hasNextPage = rows.length > limit;
  return {
    sections: rows.slice(0, limit),
    ...(hasNextPage ? { nextOffset: offset + limit } : {}),
  };
}
