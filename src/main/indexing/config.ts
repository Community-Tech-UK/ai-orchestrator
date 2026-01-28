/**
 * Codebase Indexing Configuration
 *
 * Default configuration values and helpers for the indexing system.
 */

import type { IndexingConfig, SearchConfig, ChunkConfig, MerkleTreeConfig, FileWatcherConfig, RerankerConfig } from '../../shared/types/codebase.types';

// ============================================================================
// Default Indexing Configuration
// ============================================================================

export const DEFAULT_INDEXING_CONFIG: IndexingConfig = {
  // Concurrency
  maxConcurrentFiles: 10,
  batchSize: 50,

  // Throttling
  minIntervalMs: 100,
  maxTokensPerMinute: 100000,

  // Chunking
  maxChunkTokens: 8000,
  minChunkTokens: 100,
  overlapTokens: 50,

  // Filtering
  includePatterns: [
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.mjs',
    '**/*.cjs',
    '**/*.py',
    '**/*.rs',
    '**/*.go',
    '**/*.java',
    '**/*.kt',
    '**/*.scala',
    '**/*.rb',
    '**/*.php',
    '**/*.c',
    '**/*.cpp',
    '**/*.h',
    '**/*.hpp',
    '**/*.cs',
    '**/*.swift',
    '**/*.md',
    '**/*.json',
    '**/*.yaml',
    '**/*.yml',
    '**/*.toml',
  ],
  excludePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/__pycache__/**',
    '**/.pytest_cache/**',
    '**/target/**',
    '**/vendor/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.map',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/*.lock',
  ],
  maxFileSize: 1024 * 1024, // 1MB

  // Embedding
  embeddingProvider: 'auto',
  embeddingModel: undefined,

  // Persistence
  persistAfterBatch: true,
  compactOnCompletion: true,
};

// ============================================================================
// Default Search Configuration
// ============================================================================

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  // Hybrid search weights
  bm25Weight: 0.4,
  vectorWeight: 0.6,

  // HyDE
  useHyDE: true,
  hydeContextHints: 'auto',

  // Reranking
  useReranking: true,
  rerankerProvider: 'local',
  rerankerModel: undefined,

  // Results
  defaultTopK: 10,
  maxTopK: 50,
  minScore: 0.3,

  // Diversity
  diversityThreshold: 0.7,
};

// ============================================================================
// Default Chunk Configuration
// ============================================================================

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxTokens: 8000,
  minTokens: 100,
  overlapTokens: 50,
  preserveImports: true,
  preserveComments: true,
};

// ============================================================================
// Default Merkle Tree Configuration
// ============================================================================

export const DEFAULT_MERKLE_CONFIG: MerkleTreeConfig = {
  ignorePatterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__pycache__',
    '.pytest_cache',
    'target',
    'vendor',
  ],
  includeExtensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.scala',
    '.rb',
    '.php',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.swift',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
  ],
  hashAlgorithm: 'xxhash',
};

// ============================================================================
// Default File Watcher Configuration
// ============================================================================

export const DEFAULT_FILE_WATCHER_CONFIG: FileWatcherConfig = {
  debounceMs: 500,
  ignorePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
  ],
  maxPendingChanges: 1000,
  autoIndex: true,
};

// ============================================================================
// Default Reranker Configuration
// ============================================================================

export const DEFAULT_RERANKER_CONFIG: RerankerConfig = {
  provider: 'local',
  model: undefined,
  apiKey: undefined,
  batchSize: 25,
  maxCandidates: 50,
};

// ============================================================================
// Language Detection
// ============================================================================

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.rb': 'ruby',
  '.erb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.lua': 'lua',
  '.r': 'r',
  '.R': 'r',
  '.jl': 'julia',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.fs': 'fsharp',
  '.fsi': 'fsharp',
  '.fsx': 'fsharp',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.edn': 'clojure',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'fish',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
};

// ============================================================================
// Tree-sitter Language Support
// ============================================================================

export const TREE_SITTER_SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'ruby',
] as const;

export type TreeSitterLanguage = (typeof TREE_SITTER_SUPPORTED_LANGUAGES)[number];

export function isTreeSitterSupported(language: string): language is TreeSitterLanguage {
  return TREE_SITTER_SUPPORTED_LANGUAGES.includes(language as TreeSitterLanguage);
}

// ============================================================================
// Helper Functions
// ============================================================================

export function getLanguageFromExtension(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] || 'unknown';
}

export function mergeIndexingConfig(
  base: IndexingConfig,
  overrides: Partial<IndexingConfig>
): IndexingConfig {
  return {
    ...base,
    ...overrides,
    includePatterns: overrides.includePatterns ?? base.includePatterns,
    excludePatterns: overrides.excludePatterns ?? base.excludePatterns,
  };
}

export function mergeSearchConfig(
  base: SearchConfig,
  overrides: Partial<SearchConfig>
): SearchConfig {
  return {
    ...base,
    ...overrides,
  };
}

export function shouldIncludeFile(
  filePath: string,
  config: Pick<IndexingConfig, 'includePatterns' | 'excludePatterns' | 'maxFileSize'>,
  fileSize?: number
): boolean {
  // Check file size
  if (fileSize !== undefined && fileSize > config.maxFileSize) {
    return false;
  }

  // Check if excluded
  for (const pattern of config.excludePatterns) {
    if (matchGlobPattern(filePath, pattern)) {
      return false;
    }
  }

  // Check if included
  for (const pattern of config.includePatterns) {
    if (matchGlobPattern(filePath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Simple glob pattern matching
 * Supports: *, **, ?
 */
export function matchGlobPattern(path: string, pattern: string): boolean {
  // Escape regex special chars except *, ?, **
  let regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/{{GLOBSTAR}}/g, '.*');

  // Anchor to start/end
  regexPattern = `^${regexPattern}$`;

  return new RegExp(regexPattern).test(path);
}
