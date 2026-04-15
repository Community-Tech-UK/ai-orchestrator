import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
  FilePathSchema,
  DirectoryPathSchema,
  SnapshotIdSchema,
  StoreIdSchema,
} from './common.schemas';

// ============ Settings ============

export const SettingsGetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

export const SettingsUpdatePayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(), // Settings can be various types
});

export const SettingsBulkUpdatePayloadSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
}).passthrough(); // Allow direct settings as well

export const SettingsResetOnePayloadSchema = z.object({
  key: z.string().min(1).max(100),
});

// NOTE: SettingsUpdatePayload interface already defined in transport.types.ts

export const SettingsSetPayloadSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.unknown(),
});

// ============ Config ============

const ConfigPathSchema = z.string().min(1).max(2000);

export const ConfigResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const ConfigGetProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
});

export const ConfigSaveProjectPayloadSchema = z.object({
  configPath: ConfigPathSchema,
  config: z.record(z.string(), z.unknown()), // ProjectConfig is complex, validate structure
});

export const ConfigCreateProjectPayloadSchema = z.object({
  projectDir: WorkingDirectorySchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigFindProjectPayloadSchema = z.object({
  startDir: WorkingDirectorySchema,
});

export const InstructionsResolvePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

export const InstructionsCreateDraftPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  contextPaths: z.array(FilePathSchema).max(500).optional(),
});

// ============ Remote Config ============

const UrlSchema = z.string().url().max(2000);
const DomainSchema = z.string().min(1).max(255);
const GitHubOwnerSchema = z.string().min(1).max(100);
const GitHubRepoSchema = z.string().min(1).max(100);

export const RemoteConfigFetchUrlPayloadSchema = z.object({
  url: UrlSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  useCache: z.boolean().optional(),
});

export const RemoteConfigFetchWellKnownPayloadSchema = z.object({
  domain: DomainSchema,
  timeout: z.number().int().min(0).max(60000).optional(),
  cacheTTL: z.number().int().min(0).optional(),
});

export const RemoteConfigFetchGitHubPayloadSchema = z.object({
  owner: GitHubOwnerSchema,
  repo: GitHubRepoSchema,
  branch: z.string().max(100).optional(),
});

export const RemoteConfigDiscoverGitPayloadSchema = z.object({
  gitRemoteUrl: UrlSchema,
});

export const RemoteConfigInvalidatePayloadSchema = z.object({
  url: UrlSchema,
});

export const RemoteObserverStartPayloadSchema = z.object({
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

// ============ File Operations ============

// Editor operations
export const EditorOpenFilePayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).optional(),
  column: z.number().int().min(0).optional(),
  waitForClose: z.boolean().optional(),
  newWindow: z.boolean().optional(),
});

export const EditorOpenFileAtLinePayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0),
  column: z.number().int().min(0).optional(),
});

export const EditorOpenDirectoryPayloadSchema = z.object({
  dirPath: DirectoryPathSchema,
});

export const EditorSetPreferredPayloadSchema = z.object({
  type: z.string().min(1).max(50),
  path: z.string().max(2000).optional(),
  args: z.array(z.string().max(500)).max(20).optional(),
});

// Watcher operations
export const WatcherStartPayloadSchema = z.object({
  directory: DirectoryPathSchema,
  ignored: z.array(z.string().max(500)).max(100).optional(),
  useGitignore: z.boolean().optional(),
  depth: z.number().int().min(0).max(20).optional(),
  ignoreInitial: z.boolean().optional(),
  debounceMs: z.number().int().min(0).max(10000).optional(),
});

export const WatcherStopPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

export const WatcherGetChangesPayloadSchema = z.object({
  sessionId: SessionIdSchema,
  limit: z.number().int().min(1).max(1000).optional(),
});

export const WatcherClearBufferPayloadSchema = z.object({
  sessionId: SessionIdSchema,
});

// Multi-edit operations
export const MultiEditOperationSchema = z.object({
  filePath: FilePathSchema,
  oldString: z.string().max(100000),
  newString: z.string().max(100000),
  mode: z.enum(['exact', 'regex']).optional(),
});

export const MultiEditPayloadSchema = z.object({
  edits: z.array(MultiEditOperationSchema).min(1).max(100),
  instanceId: InstanceIdSchema.optional(),
  takeSnapshots: z.boolean().optional(),
});

// ============ Codebase Operations ============

export const CodebaseIndexStorePayloadSchema = z.object({
  storeId: StoreIdSchema,
  rootPath: DirectoryPathSchema,
  options: z.object({
    force: z.boolean().optional(),
    filePatterns: z.array(z.string().max(500)).max(100).optional(),
  }).optional(),
});

export const CodebaseIndexFilePayloadSchema = z.object({
  storeId: StoreIdSchema,
  filePath: FilePathSchema,
});

export const CodebaseWatcherPayloadSchema = z.object({
  storeId: StoreIdSchema,
  rootPath: DirectoryPathSchema.optional(),
});

// ============ Security Payloads ============

export const SecurityDetectSecretsPayloadSchema = z.object({
  content: z.string().max(500_000),
  contentType: z.enum(['env', 'text', 'auto']).optional(),
});

export const SecurityRedactContentPayloadSchema = z.object({
  content: z.string().max(500_000),
  contentType: z.enum(['env', 'text', 'auto']).optional(),
  options: z.object({
    maskChar: z.string().max(1).optional(),
    showStart: z.number().int().min(0).max(10).optional(),
    showEnd: z.number().int().min(0).max(10).optional(),
    fullMask: z.boolean().optional(),
    label: z.string().max(100).optional(),
  }).optional(),
});

export const SecurityCheckFilePayloadSchema = z.object({
  filePath: z.string().min(1).max(4096),
});

export const SecurityGetAuditLogPayloadSchema = z.object({
  instanceId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});

export const SecurityCheckEnvVarPayloadSchema = z.object({
  name: z.string().min(1).max(500),
  value: z.string().max(100_000),
});

export const SecuritySetPermissionPresetPayloadSchema = z.object({
  preset: z.enum(['allow', 'ask', 'deny']),
});

export const BashValidatePayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

export const BashCommandPayloadSchema = z.object({
  command: z.string().min(1).max(100_000),
});

// ============ App / File Handler Payloads ============

export const AppOpenDocsPayloadSchema = z.object({
  filename: z.string().min(1).max(500),
});

export const DialogSelectFilesPayloadSchema = z.object({
  multiple: z.boolean().optional(),
  defaultPath: z.string().max(4096).optional(),
  filters: z.array(z.object({
    name: z.string().min(1).max(200),
    extensions: z.array(z.string().max(20)).max(50),
  })).max(20).optional(),
}).optional();

export const FileReadDirPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  includeHidden: z.boolean().optional(),
});

export const FileGetStatsPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const FileReadTextPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  maxBytes: z.number().int().min(1).max(5_242_880).optional(),
});

export const FileWriteTextPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(50_000_000),
  createDirs: z.boolean().optional(),
});

export const FileOpenPathPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

// ============ Debug & Log Payloads ============

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'fatal']);

export const LogGetRecentPayloadSchema = z.object({
  limit: z.number().int().min(1).max(10000).optional(),
  level: LogLevelSchema.optional(),
  subsystem: z.string().max(100).optional(),
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
}).optional();

export const LogSetLevelPayloadSchema = z.object({
  level: LogLevelSchema,
});

export const LogSetSubsystemLevelPayloadSchema = z.object({
  subsystem: z.string().min(1).max(100),
  level: LogLevelSchema,
});

export const LogExportPayloadSchema = z.object({
  filePath: FilePathSchema,
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
});

export const DebugAgentPayloadSchema = z.object({
  agentId: z.string().min(1).max(200),
});

export const DebugConfigPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const DebugFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const DebugAllPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

// ============ Search Payloads ============

export const SearchSemanticPayloadSchema = z.object({
  query: z.string().min(1).max(100000),
  directory: DirectoryPathSchema.optional(),
  maxResults: z.number().int().min(1).max(1000).optional(),
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
  searchType: z.enum(['semantic', 'keyword', 'hybrid']).optional(),
});

export const SearchBuildIndexPayloadSchema = z.object({
  directory: DirectoryPathSchema,
  includePatterns: z.array(z.string().max(500)).max(100).optional(),
  excludePatterns: z.array(z.string().max(500)).max(100).optional(),
});

export const SearchConfigureExaPayloadSchema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(2000).optional(),
});

// ============ Recent Directories Payloads ============

export const RecentDirsGetPayloadSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  sortBy: z.enum(['lastAccessed', 'frequency', 'alphabetical', 'manual']).optional(),
  includePinned: z.boolean().optional(),
}).optional();

export const RecentDirsAddPayloadSchema = z.object({
  path: DirectoryPathSchema,
  nodeId: z.string().min(1).max(200).optional(),
  platform: z.enum(['darwin', 'win32', 'linux']).optional(),
});

export const RecentDirsRemovePayloadSchema = z.object({
  path: DirectoryPathSchema,
});

export const RecentDirsPinPayloadSchema = z.object({
  path: DirectoryPathSchema,
  pinned: z.boolean(),
});

export const RecentDirsReorderPayloadSchema = z.object({
  paths: z.array(DirectoryPathSchema).min(1).max(1000),
});

export const RecentDirsClearPayloadSchema = z.object({
  keepPinned: z.boolean().optional(),
}).optional();

// ============ LSP Payloads ============

export const LspPositionPayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).max(1000000),
  character: z.number().int().min(0).max(100000),
});

export const LspFindReferencesPayloadSchema = z.object({
  filePath: FilePathSchema,
  line: z.number().int().min(0).max(1000000),
  character: z.number().int().min(0).max(100000),
  includeDeclaration: z.boolean().optional(),
});

export const LspFilePayloadSchema = z.object({
  filePath: FilePathSchema,
});

export const LspWorkspaceSymbolPayloadSchema = z.object({
  query: z.string().min(0).max(1000),
  rootPath: DirectoryPathSchema.optional(),
});

// ============ Codebase Search Payloads ============

export const CodebaseSearchPayloadSchema = z.object({
  options: z.object({
    query: z.string().min(1).max(100000),
    storeId: StoreIdSchema,
    topK: z.number().int().min(1).max(1000).optional(),
    bm25Weight: z.number().min(0).max(1).optional(),
    vectorWeight: z.number().min(0).max(1).optional(),
    useHyDE: z.boolean().optional(),
  }),
});

export const CodebaseSearchSymbolsPayloadSchema = z.object({
  storeId: StoreIdSchema,
  query: z.string().min(1).max(100000),
});

// ============ VCS Payloads ============

export const VcsIsRepoPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetStatusPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetBranchesPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
});

export const VcsGetCommitsPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

export const VcsGetDiffPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  type: z.enum(['staged', 'unstaged', 'between']),
  fromRef: z.string().max(500).optional(),
  toRef: z.string().max(500).optional(),
  filePath: FilePathSchema.optional(),
});

export const VcsGetFileHistoryPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
  limit: z.number().int().min(1).max(10000).optional(),
});

export const VcsGetFileAtCommitPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
  commitHash: z.string().min(1).max(500),
});

export const VcsGetBlamePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePath: FilePathSchema,
});

// ============ Knowledge Graph Payloads ============

export const KgAddFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceCloset: z.string().optional(),
  sourceFile: z.string().optional(),
});

export const KgInvalidateFactPayloadSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  ended: z.string().optional(),
});

export const KgQueryEntityPayloadSchema = z.object({
  entityName: z.string().min(1),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
  asOf: z.string().optional(),
});

export const KgQueryRelationshipPayloadSchema = z.object({
  predicate: z.string().min(1),
  asOf: z.string().optional(),
});

export const KgTimelinePayloadSchema = z.object({
  entityName: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const KgAddEntityPayloadSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

// ============ Conversation Mining Payloads ============

export const ConvoImportFilePayloadSchema = z.object({
  filePath: z.string().min(1),
  wing: z.string().min(1),
});

export const ConvoImportStringPayloadSchema = z.object({
  content: z.string().min(1),
  wing: z.string().min(1),
  sourceFile: z.string().min(1),
  format: z.enum([
    'claude-code-jsonl', 'codex-jsonl', 'claude-ai-json',
    'chatgpt-json', 'slack-json', 'plain-text',
  ]).optional(),
});

export const ConvoDetectFormatPayloadSchema = z.object({
  content: z.string().min(1),
});

// ============ Wake Context Payloads ============

export const WakeGeneratePayloadSchema = z.object({
  wing: z.string().optional(),
});

export const WakeAddHintPayloadSchema = z.object({
  content: z.string().min(1),
  importance: z.number().min(0).max(10).optional(),
  room: z.string().optional(),
  sourceReflectionId: z.string().optional(),
  sourceSessionId: z.string().optional(),
});

export const WakeRemoveHintPayloadSchema = z.object({
  id: z.string().min(1),
});

export const WakeSetIdentityPayloadSchema = z.object({
  text: z.string().min(1).max(500),
});

export const WakeListHintsPayloadSchema = z.object({
  room: z.string().optional(),
});

// ============ Codebase Mining Payloads ============

export const CodebaseMineDirectoryPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebaseGetStatusPayloadSchema = z.object({
  dirPath: z.string().min(1),
});
