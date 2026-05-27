import type { ContextSection, ContextStore } from '../../shared/types/rlm.types';

const DEFAULT_SECTION_LIMIT = 1_000;
const DEFAULT_CONTENT_PREVIEW_CHARS = 0;

export interface SerializeSectionOptions {
  includeContent?: boolean;
  maxContentChars?: number;
}

export interface SerializeStoreOptions extends SerializeSectionOptions {
  includeSections?: boolean;
  sectionLimit?: number;
}

export function serializeContextSectionForIpc(
  section: ContextSection,
  options: SerializeSectionOptions = {},
): ContextSection {
  const includeContent = options.includeContent === true;
  const maxContentChars = options.maxContentChars ?? DEFAULT_CONTENT_PREVIEW_CHARS;
  const content = includeContent
    ? section.content.slice(0, Math.max(0, maxContentChars))
    : '';

  return {
    ...section,
    content,
    summarizes: section.summarizes ? [...section.summarizes] : undefined,
  };
}

export function serializeContextStoreForIpc(
  store: ContextStore,
  options: SerializeStoreOptions = {},
): ContextStore {
  const includeSections = options.includeSections === true;
  const sectionLimit = Math.max(0, options.sectionLimit ?? DEFAULT_SECTION_LIMIT);
  const sectionCount = store.sections.length;
  const sections = includeSections
    ? store.sections
      .slice(0, sectionLimit)
      .map((section) => serializeContextSectionForIpc(section, options))
    : [];

  return {
    id: store.id,
    instanceId: store.instanceId,
    sections,
    totalTokens: store.totalTokens,
    totalSize: store.totalSize,
    createdAt: store.createdAt,
    lastAccessed: store.lastAccessed,
    accessCount: store.accessCount,
    config: {
      ...(store.config ?? {}),
      ipcSectionCount: sectionCount,
      ipcSectionsTruncated: !includeSections || sectionCount > sectionLimit,
    },
  };
}

export function isHighVolumeContextStore(store: ContextStore): boolean {
  return store.config?.['kind'] === 'codebase-auto';
}
