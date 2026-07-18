import { z } from 'zod';
import {
  InstanceIdSchema,
  SessionIdSchema,
  FilePathSchema,
  DirectoryPathSchema,
  StoreIdSchema,
} from './common.schemas';

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

export const WatcherFileChangedEventSchema = z.object({
  sessionId: SessionIdSchema,
  type: z.enum(['add', 'change', 'unlink', 'addDir', 'unlinkDir']),
  path: FilePathSchema,
  relativePath: z.string().max(10_000),
  timestamp: z.number().int().nonnegative(),
}).strict();

export const WatcherErrorEventSchema = z.object({
  sessionId: SessionIdSchema,
  message: z.string().min(1).max(10_000),
}).strict();

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

export const CodebaseIndexProgressEventSchema = z.object({
  status: z.enum(['idle', 'scanning', 'chunking', 'complete', 'error', 'cancelled']),
  totalFiles: z.number().int().nonnegative(),
  processedFiles: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  rootPath: z.string().max(10_000).optional(),
  currentFile: z.string().max(10_000).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  errorMessage: z.string().max(10_000).optional(),
  eta: z.number().nonnegative().finite().optional(),
}).strict();

export const CodebaseWatcherChangesEventSchema = z.object({
  storeId: StoreIdSchema,
  count: z.number().int().nonnegative(),
}).strict();

export const CodebaseAutoStatusChangedEventSchema = z.object({
  rootPath: z.string().min(1).max(10_000),
  storeId: StoreIdSchema,
  state: z.enum(['idle', 'queued', 'running', 'complete', 'skipped', 'failed']),
  reason: z.enum(['too_large', 'excluded', 'disabled', 'remote', 'error']).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  filesProcessed: z.number().int().nonnegative().optional(),
  chunksProcessed: z.number().int().nonnegative().optional(),
  errorMessage: z.string().max(10_000).optional(),
}).strict();

// Note: the legacy `CodebaseAutoHintPayloadSchema` was removed when the
// per-subsystem hint channels (CODEBASE_AUTO_HINT, CODEMEM_PREWARM_HINT)
// were consolidated into a single `WORKSPACE_HINT_ACTIVE` channel. See
// `WorkspaceHintActivePayloadSchema` in workspace-tools.schemas.ts.

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

export const FileReadBytesPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  maxBytes: z.number().int().min(1).max(50_000_000).optional(),
});

export const FileWriteTextPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(50_000_000),
  createDirs: z.boolean().optional(),
});

export const FileOpenPathPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

/**
 * Payload for opening the user's terminal application at a working directory.
 * The renderer passes a directory; the main process spawns the platform-native
 * terminal there (Terminal.app on macOS, Windows Terminal/cmd on Windows,
 * x-terminal-emulator or common terminals on Linux).
 */
export const FileOpenTerminalPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

export const FileCopyToClipboardPayloadSchema = z.object({
  path: z.string().min(1).max(4096),
});

// ─────────────────────────────────────────────────────────────────────────────
// VCS renderer event payloads (main → renderer pushes)
// ─────────────────────────────────────────────────────────────────────────────

/** `vcs:status-changed` — GitStatusChangedEvent from the git status watcher. */
export const VcsStatusChangedEventSchema = z.object({
  repoPath: z.string(),
  reason: z.enum(['index', 'head', 'refs', 'remotes', 'packed-refs', 'worktree']),
  timestamp: z.number(),
}).strict();

/** `vcs:operation-progress` — fetch/pull/push progress envelope. */
export const VcsOperationProgressEventSchema = z.object({
  opId: z.string(),
  kind: z.enum(['fetch', 'pull', 'push']),
  phase: z.enum(['started', 'running', 'completed', 'cancelled', 'failed']),
  repoPath: z.string(),
  durationMs: z.number().optional(),
  message: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(),
}).strict();
