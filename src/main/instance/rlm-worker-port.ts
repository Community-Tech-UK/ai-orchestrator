import type {
  ContextSection,
  ContextStore,
  QueryType,
  RecursiveCall,
  RLMConfig,
  RLMSessionStats,
  RLMStoreStats,
} from '../../shared/types/rlm.types';
import type { StorageStats } from '../rlm/context';

/** Plain values accepted by renderer validation and safe to structured-clone. */
export type RlmCloneValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | RlmCloneValue[]
  | { [key: string]: RlmCloneValue };

export interface RlmContextQueryDto {
  type: QueryType;
  params: Record<string, RlmCloneValue>;
}

export interface RlmContextQueryResultDto {
  query: RlmContextQueryDto;
  result: string;
  tokensUsed: number;
  sectionsAccessed: string[];
  duration: number;
  subQueries?: RlmContextQueryResultDto[];
  depth: number;
}

export type RlmContextSectionDto = Omit<ContextSection, 'content'> & {
  content: string;
};

export type RlmContextStoreDto = Pick<
  ContextStore,
  | 'id'
  | 'instanceId'
  | 'totalTokens'
  | 'totalSize'
  | 'createdAt'
  | 'lastAccessed'
  | 'accessCount'
> & {
  sections: RlmContextSectionDto[];
  config?: Record<string, RlmCloneValue>;
};

export interface RlmSessionDto {
  id: string;
  storeId: string;
  instanceId: string;
  queries: RlmContextQueryResultDto[];
  recursiveCalls: RecursiveCall[];
  totalRootTokens: number;
  totalSubQueryTokens: number;
  estimatedDirectTokens: number;
  tokenSavingsPercent: number;
  startedAt: number;
  lastActivityAt: number;
}

export interface RlmTokenSavingsStatDto {
  date: string;
  directTokens: number;
  actualTokens: number;
  savingsPercent: number;
}

export interface RlmSectionFilterMetadataPageDto {
  sections: Array<{
    type: ContextSection['type'];
    filePath?: string;
  }>;
  nextOffset?: number;
}

export interface RlmQueryStatDto {
  type: string;
  count: number;
  avgDuration: number;
  avgTokens: number;
}

export type RlmRendererWorkerRequest =
  | {
    kind: 'create-store';
    instanceId: string;
    config?: Record<string, RlmCloneValue>;
  }
  | { kind: 'delete-store'; storeId: string }
  | { kind: 'get-store'; storeId: string }
  | { kind: 'list-stores' }
  | {
    kind: 'add-section';
    storeId: string;
    type: ContextSection['type'];
    name: string;
    content: string;
    metadata?: Partial<RlmContextSectionDto>;
  }
  | { kind: 'remove-section'; storeId: string; sectionId: string }
  | { kind: 'list-sections'; storeId: string }
  | { kind: 'start-session'; storeId: string; instanceId: string }
  | { kind: 'end-session'; sessionId: string }
  | { kind: 'get-session'; sessionId: string }
  | { kind: 'list-sessions' }
  | {
    kind: 'execute-query';
    sessionId: string;
    query: RlmContextQueryDto;
    depth?: number;
  }
  | { kind: 'get-store-stats'; storeId: string }
  | { kind: 'get-session-stats'; sessionId: string }
  | { kind: 'get-storage-stats' }
  | { kind: 'get-query-stats'; days: number }
  | { kind: 'get-token-savings-history'; days: number }
  | { kind: 'configure'; config: Partial<RLMConfig> };

export type RlmWorkerRequest =
  | RlmRendererWorkerRequest
  | { kind: 'get-store-by-instance'; instanceId: string }
  | {
    kind: 'list-section-filter-metadata';
    storeId: string;
    offset: number;
    limit: number;
  };

interface RlmWorkerResultByKind {
  'create-store': RlmContextStoreDto;
  'delete-store': void;
  'get-store': RlmContextStoreDto | undefined;
  'get-store-by-instance': RlmContextStoreDto | undefined;
  'list-section-filter-metadata': RlmSectionFilterMetadataPageDto;
  'list-stores': RlmContextStoreDto[];
  'add-section': RlmContextSectionDto;
  'remove-section': boolean;
  'list-sections': RlmContextSectionDto[];
  'start-session': RlmSessionDto;
  'end-session': void;
  'get-session': RlmSessionDto | undefined;
  'list-sessions': RlmSessionDto[];
  'execute-query': RlmContextQueryResultDto;
  'get-store-stats': RLMStoreStats | undefined;
  'get-session-stats': RLMSessionStats | undefined;
  'get-storage-stats': StorageStats;
  'get-query-stats': RlmQueryStatDto[];
  'get-token-savings-history': RlmTokenSavingsStatDto[];
  configure: void;
}

export type RlmWorkerResult<TRequest extends RlmWorkerRequest = RlmWorkerRequest> =
  TRequest extends { kind: infer TKind extends keyof RlmWorkerResultByKind }
    ? RlmWorkerResultByKind[TKind]
    : never;

export class RlmWorkerRpcError extends Error {
  override readonly name: string = 'RlmWorkerRpcError';
}

export class RlmWorkerRpcTimeoutError extends RlmWorkerRpcError {
  override readonly name: string = 'RlmWorkerRpcTimeoutError';
}

export interface RlmWorkerPort {
  invokeRlm<TRequest extends RlmWorkerRequest>(
    request: TRequest,
  ): Promise<RlmWorkerResult<TRequest>>;
}
