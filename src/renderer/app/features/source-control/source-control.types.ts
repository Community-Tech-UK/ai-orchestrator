/**
 * Shared types for the Source Control feature.
 *
 * These intentionally mirror the main-process `VcsManager` shapes loosely
 * (string union for status, plain interfaces) instead of importing from
 * `src/main/...` — renderer code must not reach into main-process modules.
 */

export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
  staged: boolean;
}

export interface GitStatusResponse {
  branch: string;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  hasChanges: boolean;
  isClean: boolean;
}

export interface RepoState {
  /** Absolute path to the repo root. */
  absolutePath: string;
  /** Display name — the basename of `absolutePath`. */
  name: string;
  /** Path relative to the panel's `rootPath`, for grouping/sorting. */
  relativePath: string;
  status: GitStatusResponse | null;
  error: string | null;
  loading: boolean;
}

export interface DiffViewerRequest {
  workingDirectory: string;
  repoName: string;
  filePath: string;
  staged: boolean;
}

// ---------------------------------------------------------------------------
// Diff types (shared between the modal viewer and the inline expansion).
// Mirror the main-process `VcsManager.DiffResult` shape loosely so the
// renderer doesn't reach into main-process modules.
// ---------------------------------------------------------------------------

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  isBinary?: boolean;
}

export interface DiffResult {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/** A single rendered line in the diff view, post-classification. */
export interface RenderedDiffLine {
  kind: 'add' | 'remove' | 'context' | 'header' | 'meta';
  text: string;
}

/**
 * Branch description for the per-repo branch switcher dropdown
 * (Phase 2d item 11). Mirrors `VcsManager.BranchInfo` loosely.
 */
export interface BranchInfo {
  name: string;
  current: boolean;
  tracking?: string;
  ahead?: number;
  behind?: number;
}
