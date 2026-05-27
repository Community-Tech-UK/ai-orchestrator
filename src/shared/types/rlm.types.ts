/**
 * RLM (Recursive Language Model) Types
 * Based on arXiv:2512.24601 from MIT OASYS Lab
 *
 * Key paradigm: Treat context as external environment (Python variable)
 * for programmatic manipulation via REPL-like operations
 */

export interface ContextStore {
  id: string;
  instanceId: string;

  // Content
  sections: ContextSection[];
  totalTokens: number;
  totalSize: number;

  // Indexing (for efficient search)
  searchIndex?: SearchIndex;
  summaryIndex?: SummaryIndex;
  bloomFilter?: BloomFilter; // For fast negative lookups

  // Metadata
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  config?: Record<string, unknown>;
}

/**
 * Bloom Filter for fast probabilistic set membership testing
 * Returns "definitely not in set" or "possibly in set"
 */
export interface BloomFilter {
  bits: Uint8Array;
  size: number;
  hashCount: number;
}

export interface ContextSection {
  id: string;
  type: 'file' | 'conversation' | 'tool_output' | 'external' | 'summary';
  name: string;
  content: string;
  tokens: number;

  // Efficient access metadata
  startOffset: number;
  endOffset: number;
  checksum: string;

  // Source information
  filePath?: string;
  language?: string;
  sourceUrl?: string;

  // Hierarchical summary support (Prime Intellect pattern)
  summarizes?: string[]; // IDs of sections this summarizes
  depth: number; // 0 = original, 1+ = summary depth
  parentSummaryId?: string; // Reference to parent summary
}

export interface SearchIndex {
  // Inverted index for fast search
  terms: Map<string, TermLocation[]>;
  sectionBoundaries: number[];

  // N-gram index for fuzzy matching
  ngrams?: Map<string, string[]>; // ngram -> section IDs

  // Last rebuild timestamp
  lastRebuilt: number;
}

export interface TermLocation {
  sectionId: string;
  offset: number;
  lineNumber: number;
  context?: string; // Surrounding text for quick preview
}

export interface SummaryIndex {
  // Hierarchical summaries for progressive disclosure
  levels: SummaryLevel[];

  // Quick lookup
  sectionToSummary: Map<string, string>; // section ID -> summary ID
}

export interface SummaryLevel {
  depth: number;
  sections: ContextSection[];
  totalTokens: number;
  compressionRatio: number; // Original tokens / summary tokens
}

export type QueryType =
  | 'grep' // Pattern search
  | 'slice' // Range extraction
  | 'summarize' // Compress sections
  | 'sub_query' // Recursive LLM call
  | 'get_section' // Retrieve specific section
  | 'semantic_search'; // Embedding-based search

export interface ContextQuery {
  type: QueryType;
  params: Record<string, unknown>;
}

export interface ContextQueryResult {
  query: ContextQuery;
  result: string;
  tokensUsed: number;
  sectionsAccessed: string[];
  duration: number;

  // For recursive calls
  subQueries?: ContextQueryResult[];
  depth: number;
}

export interface RecursiveCall {
  id: string;
  parentId?: string;
  depth: number;
  prompt: string;
  contextWindow: string; // Subset of context for this call
  response?: string;
  tokens: {
    input: number;
    output: number;
  };
  duration: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface RLMSession {
  id: string;
  storeId: string;
  instanceId: string;

  // Query history
  queries: ContextQueryResult[];
  recursiveCalls: RecursiveCall[];

  // Token tracking (for cost optimization)
  totalRootTokens: number;
  totalSubQueryTokens: number;
  estimatedDirectTokens: number; // What it would cost without RLM
  tokenSavingsPercent: number;

  // Timing
  startedAt: number;
  lastActivityAt: number;
}

export interface RLMConfig {
  // Query limits
  maxSectionTokens: number; // Max tokens per section (default: 8000)
  summaryThreshold: number; // When to start summarizing (default: 50000)
  searchWindowSize: number; // Tokens around search match (default: 2000)

  // Recursion limits
  maxRecursionDepth: number; // Max depth of sub-queries (default: 3)
  maxSubQueries: number; // Max parallel sub-queries (default: 10)
  subQueryTimeout: number; // Timeout per sub-query (default: 30000)

  // Summarization
  summarizeModel?: string; // Model for summarization (default: fast model)
  summaryTargetRatio: number; // Target compression ratio (default: 0.2)

  // Cost optimization
  enableCostTracking: boolean; // Track token costs
  costPerInputToken?: number; // For cost estimation
  costPerOutputToken?: number;
}

// IPC Payloads
export interface RLMCreateStorePayload {
  instanceId: string;
}

export interface RLMAddSectionPayload {
  storeId: string;
  type: ContextSection['type'];
  name: string;
  content: string;
  metadata?: Partial<ContextSection>;
}

export interface RLMStartSessionPayload {
  storeId: string;
  instanceId: string;
}

export interface RLMExecuteQueryPayload {
  sessionId: string;
  query: ContextQuery;
  depth?: number;
}

export interface RLMConfigurePayload {
  config: Partial<RLMConfig>;
}

export interface RLMGetStoreStatsPayload {
  storeId: string;
}

export interface RLMGetSessionStatsPayload {
  sessionId: string;
}

export interface RLMDeleteStorePayload {
  storeId: string;
}

export interface RLMEndSessionPayload {
  sessionId: string;
}

// Response types
export interface RLMStoreStats {
  sections: number;
  originalSections: number;
  summaries: number;
  totalTokens: number;
  summaryLevels: number;
  indexedTerms: number;
}

export interface RLMSessionStats {
  totalQueries: number;
  totalRecursiveCalls: number;
  rootTokens: number;
  subQueryTokens: number;
  estimatedSavings: number;
  avgQueryDuration: number;
}
