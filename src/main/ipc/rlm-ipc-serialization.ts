import type {
  ContextQueryResult,
  ContextSection,
  ContextStore,
  RecursiveCall,
  RLMSession,
} from '../../shared/types/rlm.types';
import type {
  RlmCloneValue,
  RlmContextQueryResultDto,
  RlmContextSectionDto,
  RlmContextStoreDto,
  RlmSessionDto,
} from '../instance/rlm-worker-port';

const DEFAULT_SECTION_LIMIT = 1_000;
const DEFAULT_CONTENT_PREVIEW_CHARS = 0;

export interface SerializeSectionOptions {
  includeContent?: boolean;
  maxContentChars?: number;
}

export interface SerializeStoreOptions extends SerializeSectionOptions {
  includeSections?: boolean;
  sectionLimit?: number;
  authoritativeSectionCount?: number;
}

export function serializeContextSectionForIpc(
  section: ContextSection,
  options: SerializeSectionOptions = {},
): RlmContextSectionDto {
  const includeContent = options.includeContent === true;
  const maxContentChars = options.maxContentChars ?? DEFAULT_CONTENT_PREVIEW_CHARS;
  const content = includeContent
    ? section.content.slice(0, Math.max(0, maxContentChars))
    : '';

  return {
    id: section.id,
    type: section.type,
    name: section.name,
    content,
    tokens: section.tokens,
    startOffset: section.startOffset,
    endOffset: section.endOffset,
    checksum: section.checksum,
    depth: section.depth,
    ...(section.filePath === undefined ? {} : { filePath: section.filePath }),
    ...(section.language === undefined ? {} : { language: section.language }),
    ...(section.sourceUrl === undefined ? {} : { sourceUrl: section.sourceUrl }),
    summarizes: section.summarizes ? [...section.summarizes] : undefined,
    ...(section.parentSummaryId === undefined
      ? {}
      : { parentSummaryId: section.parentSummaryId }),
  };
}

export function serializeContextStoreForIpc(
  store: ContextStore,
  options: SerializeStoreOptions = {},
): RlmContextStoreDto {
  const includeSections = options.includeSections === true;
  const sectionLimit = Math.max(0, options.sectionLimit ?? DEFAULT_SECTION_LIMIT);
  const sectionCount = Math.max(
    store.sections.length,
    normalizeSectionCount(options.authoritativeSectionCount),
  );
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
      ...sanitizeCloneRecord(store.config),
      ipcSectionCount: sectionCount,
      ipcSectionsTruncated: !includeSections || sectionCount > sections.length,
    },
  };
}

export function serializeContextQueryResultForIpc(
  result: ContextQueryResult,
): RlmContextQueryResultDto {
  return {
    query: {
      type: result.query.type,
      params: sanitizeCloneRecord(result.query.params),
    },
    result: result.result,
    tokensUsed: result.tokensUsed,
    sectionsAccessed: [...result.sectionsAccessed],
    duration: result.duration,
    ...(result.subQueries === undefined
      ? {}
      : { subQueries: result.subQueries.map(serializeContextQueryResultForIpc) }),
    depth: result.depth,
  };
}

export function serializeRlmSessionForIpc(session: RLMSession): RlmSessionDto {
  return {
    id: session.id,
    storeId: session.storeId,
    instanceId: session.instanceId,
    queries: session.queries.map(serializeContextQueryResultForIpc),
    recursiveCalls: session.recursiveCalls.map(serializeRecursiveCall),
    totalRootTokens: session.totalRootTokens,
    totalSubQueryTokens: session.totalSubQueryTokens,
    estimatedDirectTokens: session.estimatedDirectTokens,
    tokenSavingsPercent: session.tokenSavingsPercent,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
}

export function isHighVolumeContextStore(store: ContextStore): boolean {
  return store.config?.['kind'] === 'codebase-auto';
}

function serializeRecursiveCall(call: RecursiveCall): RecursiveCall {
  return {
    id: call.id,
    ...(call.parentId === undefined ? {} : { parentId: call.parentId }),
    depth: call.depth,
    prompt: call.prompt,
    contextWindow: call.contextWindow,
    ...(call.response === undefined ? {} : { response: call.response }),
    tokens: { input: call.tokens.input, output: call.tokens.output },
    duration: call.duration,
    status: call.status,
  };
}

const UNSERIALIZABLE = Symbol('unserializable');

function sanitizeCloneRecord(
  value: Record<string, unknown> | undefined,
): Record<string, RlmCloneValue> {
  if (!value) return {};
  const sanitized = sanitizeCloneValue(value, new WeakSet<object>());
  return sanitized === UNSERIALIZABLE || Array.isArray(sanitized)
    ? {}
    : sanitized as Record<string, RlmCloneValue>;
}

function sanitizeCloneValue(
  value: unknown,
  ancestors: WeakSet<object>,
): RlmCloneValue | typeof UNSERIALIZABLE {
  if (
    value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value !== 'object') return UNSERIALIZABLE;
  if (ancestors.has(value)) return UNSERIALIZABLE;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const sanitized = sanitizeCloneValue(item, ancestors);
        return sanitized === UNSERIALIZABLE ? undefined : sanitized;
      });
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return UNSERIALIZABLE;

    const result: Record<string, RlmCloneValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const sanitized = sanitizeCloneValue(item, ancestors);
      if (sanitized !== UNSERIALIZABLE) result[key] = sanitized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeSectionCount(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.floor(value));
}
