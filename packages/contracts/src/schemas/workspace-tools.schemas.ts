import { z } from 'zod';
import {
  FilePathSchema,
  DirectoryPathSchema,
  WorkingDirectorySchema,
  StoreIdSchema,
} from './common.schemas';

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

export const VcsFindReposPayloadSchema = z.object({
  rootPath: DirectoryPathSchema,
  /**
   * Optional extra directory basenames to skip in addition to the built-in
   * defaults (.git, node_modules, dist, build, out, target, coverage, etc.).
   */
  ignorePatterns: z.array(z.string().min(1).max(200)).max(200).optional(),
});

/**
 * Replace the set of repos the main-process `GitStatusWatcher` is
 * tracking. Passing `repoPaths: []` stops all watchers (e.g. when the
 * instance is deselected).
 */
export const VcsWatchReposPayloadSchema = z.object({
  repoPaths: z.array(DirectoryPathSchema).max(500),
});

/**
 * Phase 2d (item 7) — stage / unstage write actions.
 *
 * Paths are passed to git after the `--` separator, so they cannot be
 * interpreted as flags. Each path uses `FilePathSchema` (non-empty,
 * ≤2000 chars). The list itself is capped at 5000 entries to avoid
 * accidental enormous batches from a buggy renderer multiselect.
 */
export const VcsStageFilesPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePaths: z.array(FilePathSchema).min(1).max(5000),
});

export const VcsUnstageFilesPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePaths: z.array(FilePathSchema).min(1).max(5000),
});

/**
 * Phase 2d (item 8) — discard changes.
 *
 * For each path the handler will:
 *   - If the path is a tracked file with staged and/or unstaged changes,
 *     run `git restore --source=HEAD --staged --worktree -- <path>` so
 *     both sides drop to HEAD.
 *   - If the path is untracked (file or directory), move it to the
 *     system trash via Electron's `shell.trashItem` so the user can
 *     recover from the trash if they regret it.
 *
 * The handler picks the right command per-path. The renderer just passes
 * the selection.
 */
export const VcsDiscardFilesPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  filePaths: z.array(FilePathSchema).min(1).max(5000),
});

/**
 * Phase 2d (item 9) — commit.
 *
 * Note: `message` is the full commit message body. We don't add a
 * length cap because git itself doesn't, and renderers may compose
 * conventional-commit bodies that legitimately exceed any small limit.
 * A pragmatic 64KB ceiling (2^16) is plenty.
 */
export const VcsCommitPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  message: z.string().min(1).max(65536),
  signoff: z.boolean().optional(),
  amend: z.boolean().optional(),
});

/** Phase 2d (item 10) — fetch. */
export const VcsFetchPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  remote: z.string().min(1).max(200).optional(),
  prune: z.boolean().optional(),
  /** Renderer-supplied operation id for progress / cancel correlation. */
  opId: z.string().min(1).max(200),
});

/** Phase 2d (item 10) — pull (fast-forward only for safety). */
export const VcsPullPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  remote: z.string().min(1).max(200).optional(),
  branch: z.string().min(1).max(200).optional(),
  opId: z.string().min(1).max(200),
});

/** Phase 2d (item 10) — push. */
export const VcsPushPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  remote: z.string().min(1).max(200).optional(),
  branch: z.string().min(1).max(200).optional(),
  /** Pass `force-with-lease` style safety. */
  forceWithLease: z.boolean().optional(),
  setUpstream: z.boolean().optional(),
  opId: z.string().min(1).max(200),
});

/** Phase 2d (item 11) — branch switcher. */
export const VcsCheckoutBranchPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  branchName: z.string().min(1).max(200),
  force: z.boolean().optional(),
});

/** Cancel an in-flight long-running VCS op by its operation id. */
export const VcsOperationCancelPayloadSchema = z.object({
  opId: z.string().min(1).max(200),
});
