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
